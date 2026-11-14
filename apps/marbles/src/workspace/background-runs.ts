import { resolve } from "node:path";
import type { RunStatus } from "@foundry/workflows/types";
import type { Output } from "ai";
import type { Catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import { AGENT_DEFINITION } from "~/lib/handles";
import { buildDefinition } from "~/lib/managers/agents";
import { TERMINAL_RUN_STATUSES } from "~/lib/state/runs";
import type {
  AgentDefinition,
  AgentLike,
  AgentRoute,
  Context,
  Session,
  SessionOptions,
  SessionRef,
} from "~/lib/types";
import type {
  DispatchInfo,
  DispatchOptions,
  RunInfo,
} from "~/model/connection";

const AGENT_DISPATCH = "agent-dispatch";

/**
 * A declared agent as a dispatch opens it, its definition changed by
 * `overlay`. One declared with a function is built as the session opens,
 * for the route asked for, so it chooses its skills and servers for that
 * route, and a continued session gives it the input it kept.
 */
async function dispatched(
  declared: AgentLike<Output.Output>,
  route: AgentRoute,
  overlay: (
    definition: AgentDefinition<Output.Output>
  ) => AgentDefinition<Output.Output>
): Promise<AgentLike<Output.Output>> {
  if (!Reflect.has(declared, AGENT_DEFINITION)) {
    return overlay(await buildDefinition(declared, route));
  }
  const agent = { id: declared.id, kind: "agent" as const, ...route };
  Object.defineProperty(agent, AGENT_DEFINITION, {
    value: async (kept: AgentRoute, input: unknown) =>
      overlay(await buildDefinition(declared, { ...kept, ...route }, input)),
  });
  // Opening a session reads only the data and the builder, never the calls.
  return agent as unknown as AgentLike<Output.Output>;
}
interface AgentInput extends DispatchOptions {
  readonly session: SessionRef;
}
interface AgentResult {
  readonly output: unknown;
  readonly text: string;
}

function runStatus(status: RunStatus): RunInfo["status"] {
  return status === "complete" ? "completed" : status;
}

type RunDetails = Omit<RunInfo, "status">;

interface Held {
  completion: Promise<void>;
  readonly record: RunDetails;
}

/** One host's background work, registered through the engine's live registry. */
export class BackgroundRuns {
  readonly #engine: Engine;
  readonly #catalog: Catalog;
  readonly #held = new Map<string, Held>();
  readonly #sessions = new Map<string, Session<Output.Output>>();
  readonly #closing = new AbortController();

  constructor(engine: Engine, catalog: Catalog) {
    this.#engine = engine;
    this.#catalog = catalog;
    if (engine.has(AGENT_DISPATCH)) {
      throw new Error(`reserved definition "${AGENT_DISPATCH}" already exists`);
    }
    engine.define({
      fn: (context: Context<AgentInput>) => this.#dispatch(context),
      kind: "step",
      name: AGENT_DISPATCH,
    });
  }

  async #dispatch({
    input,
    signal,
    stream,
  }: Context<AgentInput>): Promise<AgentResult> {
    const session = this.#sessions.get(input.session.id);
    if (!session) {
      throw new Error("agent dispatch session is no longer available");
    }
    const timeout = new AbortController();
    const timer =
      input.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => timeout.abort(new Error("agent dispatch timed out")),
            input.timeoutMs
          );
    const turnSignal = AbortSignal.any([signal, timeout.signal]);
    try {
      const reply = await session.generate(input.prompt, {
        onText: (text) => stream.write(text),
        signal: turnSignal,
      });
      turnSignal.throwIfAborted();
      const failure = reply.parts.find((part) => part.type === "error");
      if (failure || reply.status === "error") {
        throw new Error(
          failure?.type === "error" ? failure.message : "agent execution failed"
        );
      }
      return { output: reply.output, text: reply.text };
    } finally {
      clearTimeout(timer);
    }
  }

  definitions(): ReturnType<Engine["definitions"]> {
    return this.#engine
      .definitions()
      .filter((entry) => entry.name !== AGENT_DISPATCH);
  }

  async startWorkflow(name: string, input: unknown): Promise<DispatchInfo> {
    this.#closing.signal.throwIfAborted();
    if (!this.definitions().some((entry) => entry.name === name)) {
      throw new Error(`no workflow or step named "${name}"`);
    }
    const launched = await this.#engine.launch(name, input);
    return this.#track(
      launched,
      { kind: "workflow", name },
      (value, record) => {
        record.output = value;
      }
    );
  }

  async start(options: DispatchOptions): Promise<DispatchInfo> {
    this.#closing.signal.throwIfAborted();
    const declared =
      options.agent === undefined
        ? undefined
        : this.#catalog.agents.get(options.agent);
    if (options.agent !== undefined && !declared) {
      throw new Error(`no agent named "${options.agent}"`);
    }
    const route: AgentRoute = {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
    };
    const overlay = (
      base: AgentDefinition<Output.Output>
    ): AgentDefinition<Output.Output> => ({
      ...base,
      ...(options.instructions === undefined
        ? {}
        : {
            prompt: [declared ? base.prompt : undefined, options.instructions]
              .filter(Boolean)
              .join("\n\n"),
          }),
      ...route,
    });
    const agent = declared
      ? await dispatched(declared, route, overlay)
      : overlay({
          id: `agent-${crypto.randomUUID()}`,
          kind: "agent",
          prompt: "Complete the user's task.",
        });
    const sessionOptions: SessionOptions = {
      ...(options.compaction === undefined
        ? {}
        : { compaction: options.compaction }),
      ...(options.cwd === undefined
        ? {}
        : { cwd: resolve(this.#engine.bindings.root, options.cwd) }),
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
      ...(options.session === undefined ? {} : { session: options.session }),
    };
    const session = await this.#engine.agents.session(agent, sessionOptions);
    this.#closing.signal.throwIfAborted();
    if (this.#sessions.has(session.ref.id)) {
      throw new Error("this session already has an active agent dispatch");
    }
    this.#sessions.set(session.ref.id, session);
    try {
      const launched = await this.#engine.launch<AgentResult>(AGENT_DISPATCH, {
        ...options,
        session: session.ref,
      });
      return await this.#track(
        launched,
        { kind: "agent", name: agent.id, session: session.ref },
        (value, record) => {
          record.text = value.text;
          record.output = value.output;
        }
      );
    } catch (error) {
      this.#sessions.delete(session.ref.id);
      throw error;
    }
  }

  async #track<O>(
    launched: { readonly id: string; readonly result: Promise<O> },
    meta: Pick<RunInfo, "kind" | "name" | "session">,
    apply: (value: O, record: RunDetails) => void
  ): Promise<DispatchInfo> {
    const record: RunDetails = { ...meta, runId: launched.id };
    const held: Held = { completion: Promise.resolve(), record };
    this.#held.set(record.runId, held);
    const complete = async (): Promise<void> => {
      try {
        const value = await launched.result;
        apply(value, record);
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
      } finally {
        if (record.session) {
          this.#sessions.delete(record.session.id);
        }
      }
    };
    held.completion = complete();
    if (this.#closing.signal.aborted) {
      await this.cancel(record.runId);
      await held.completion;
      this.#closing.signal.throwIfAborted();
    }
    // Never expose timing-dependent result fields on a dispatch acknowledgement.
    return {
      ...meta,
      runId: record.runId,
      status: runStatus((await this.#lookup(record.runId)).status),
    };
  }

  async get(runId: string): Promise<RunInfo> {
    const { status, held } = await this.#lookup(runId);
    if (TERMINAL_RUN_STATUSES.has(status)) {
      await held.completion;
    }
    return {
      ...held.record,
      status: runStatus(status),
    };
  }

  async #lookup(runId: string) {
    const held = this.#held.get(runId);
    if (!held) {
      throw new Error(`no run "${runId}" in this host`);
    }
    const record = (await this.#engine.runs()).find((run) => run.id === runId);
    // Admission can leave a workflow queued before its Orchestrator record exists.
    const status = record?.status ?? this.#engine.executions.get(runId)?.status;
    if (status === undefined) {
      throw new Error(`no engine run "${runId}"`);
    }
    return {
      held,
      status: status === "interrupted" ? ("failed" as const) : status,
    };
  }

  async cancel(runId: string): Promise<RunInfo> {
    if (!TERMINAL_RUN_STATUSES.has((await this.#lookup(runId)).status)) {
      try {
        await this.#engine.cancel(runId);
      } catch (error) {
        // Finishing concurrently with cancellation is already a settled outcome.
        if (!TERMINAL_RUN_STATUSES.has((await this.#lookup(runId)).status)) {
          throw error;
        }
      }
    }
    return this.get(runId);
  }

  async close(): Promise<void> {
    this.#closing.abort(new Error("background runs are closed"));
    await Promise.all(
      [...this.#held.keys()].map((runId) => this.cancel(runId))
    );
    await Promise.all([...this.#held.values()].map((held) => held.completion));
  }
}
