import { resolve } from "node:path";
import type { Output } from "ai";
import type { Catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import type { AgentDefinition, SessionOptions, SessionRef } from "~/lib/types";

export interface DispatchOptions {
  readonly agent?: string;
  readonly compaction?: boolean;
  readonly cwd?: string;
  readonly instructions?: string;
  readonly maxTurns?: number;
  readonly model?: string;
  readonly prompt: string;
  readonly provider?: string;
  readonly session?: SessionRef;
  readonly timeoutMs?: number;
}

export interface RunInfo {
  error?: string;
  readonly kind: "agent" | "workflow";
  readonly name: string;
  output?: unknown;
  readonly runId: string;
  readonly session?: SessionRef;
  status: "running" | "cancelling" | "completed" | "failed" | "cancelled";
  text?: string;
}

interface Held {
  completion: Promise<void>;
  readonly record: RunInfo;
}

/** One host's background work. Agents and workflows share engine run IDs. */
export class BackgroundRuns {
  readonly #engine: Engine;
  readonly #catalog: Catalog;
  readonly #held = new Map<string, Held>();
  readonly #sessions = new Set<string>();
  readonly #closing = new AbortController();

  constructor(engine: Engine, catalog: Catalog) {
    this.#engine = engine;
    this.#catalog = catalog;
  }

  async startWorkflow(name: string, input: unknown): Promise<RunInfo> {
    this.#closing.signal.throwIfAborted();
    if (!this.#engine.definitions().some((entry) => entry.name === name)) {
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

  async start(options: DispatchOptions): Promise<RunInfo> {
    this.#closing.signal.throwIfAborted();
    const declared =
      options.agent === undefined
        ? undefined
        : this.#catalog.agents.get(options.agent);
    if (options.agent !== undefined && !declared) {
      throw new Error(`no agent named "${options.agent}"`);
    }
    const definition: AgentDefinition<Output.Output> = {
      ...(declared ?? {
        id: `agent-${crypto.randomUUID()}`,
        kind: "agent",
        prompt: "Complete the user's task.",
      }),
      ...(options.instructions === undefined
        ? {}
        : {
            prompt: [declared?.prompt, options.instructions]
              .filter(Boolean)
              .join("\n\n"),
          }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
    };
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
    const session = await this.#engine.agents.session(
      definition,
      sessionOptions
    );
    this.#closing.signal.throwIfAborted();
    if (this.#sessions.has(session.ref.id)) {
      throw new Error("this session already has an active agent dispatch");
    }
    this.#sessions.add(session.ref.id);
    try {
      const launched = await this.#engine.launchDefinition<{
        text: string;
        output: unknown;
      }>(
        {
          fn: async ({ signal, stream }) => {
            const timeout = new AbortController();
            const timer =
              options.timeoutMs === undefined
                ? undefined
                : setTimeout(
                    () => timeout.abort(new Error("agent dispatch timed out")),
                    options.timeoutMs
                  );
            const turnSignal = AbortSignal.any([signal, timeout.signal]);
            try {
              const reply = await session.generate(options.prompt, {
                onText: (text) => stream.write(text),
                signal: turnSignal,
              });
              turnSignal.throwIfAborted();
              const failure = reply.parts.find((part) => part.type === "error");
              if (failure || reply.status === "error") {
                throw new Error(
                  failure?.type === "error"
                    ? failure.message
                    : "agent execution failed"
                );
              }
              return { output: reply.output, text: reply.text };
            } finally {
              clearTimeout(timer);
            }
          },
          kind: "step",
        },
        {}
      );
      return await this.#track(
        launched,
        { kind: "agent", name: definition.id, session: session.ref },
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
    apply: (value: O, record: RunInfo) => void
  ): Promise<RunInfo> {
    const record: RunInfo = { ...meta, runId: launched.id, status: "running" };
    const held: Held = { completion: Promise.resolve(), record };
    this.#held.set(record.runId, held);
    const complete = async (): Promise<void> => {
      try {
        const value = await launched.result;
        apply(value, record);
        record.status = "completed";
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        record.status = record.status === "cancelling" ? "cancelled" : "failed";
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
    return { ...record };
  }

  get(runId: string): RunInfo {
    const held = this.#held.get(runId);
    if (!held) {
      throw new Error(`no run "${runId}" in this host`);
    }
    return { ...held.record };
  }

  async cancel(runId: string): Promise<RunInfo> {
    const held = this.#held.get(runId);
    if (!held) {
      throw new Error(`no run "${runId}" in this host`);
    }
    if (held.record.status === "running") {
      held.record.status = "cancelling";
      await this.#engine.cancel(runId);
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
