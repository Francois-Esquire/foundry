import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sameProcess, thisProcess } from "@foundry/lib/process-identity";
import type { RunStatus } from "@foundry/workflows/types";
import type { Output } from "ai";
import type { Catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import type { ExecutionRun } from "~/lib/execution-record";
import type { ExecutionStatus } from "~/lib/execution-statuses";
import { SETTLED_EXECUTION_STATUSES } from "~/lib/execution-statuses";
import { AGENT_DEFINITION, AGENT_PROMPT } from "~/lib/handles";
import { idempotencyKeyOf } from "~/lib/launcher";
import { buildDefinition } from "~/lib/managers/agents";
import type { RunView } from "~/lib/managers/runs";
import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";
import type {
  AgentDefinition,
  AgentLike,
  AgentRoute,
  Context,
  Session,
  SessionOptions,
  SessionRef,
} from "~/lib/types";
import type { RunRecord } from "~/lib/workflow-runs";
import type {
  DispatchInfo,
  DispatchOptions,
  EnqueueOptions,
  RunInfo,
  RunListQuery,
  RunPage,
  RunSummary,
} from "~/model/connection";

const AGENT_DISPATCH = "agent-dispatch";
const DEFAULT_RUN_PAGE = 50;
const MAX_RUN_PAGE = 200;

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
  return agent as unknown as AgentLike<Output.Output>;
}
interface AgentInput extends DispatchOptions {
  readonly agentId?: string;
  readonly session: SessionRef;
}
interface AgentResult {
  readonly output: unknown;
  readonly text: string;
}

function runStatus(status: RunStatus): RunInfo["status"] {
  return status === "complete" ? "completed" : status;
}

function listedStatus(status: ExecutionStatus): RunInfo["status"] {
  return runStatus(status === "interrupted" ? "failed" : status);
}

function matching(query: RunListQuery): (run: RunSummary) => boolean {
  return (run) =>
    (query.kind === undefined || run.kind === query.kind) &&
    (query.name === undefined || run.name === query.name) &&
    (query.status === undefined || query.status.includes(run.status));
}

function isoOf(at: number | null | undefined): string | undefined {
  return at === null || at === undefined
    ? undefined
    : new Date(at).toISOString();
}

function snapshotTimes(
  status: RunStatus,
  stored: RunRecord | undefined,
  execution: ExecutionRun | undefined
): Pick<RunInfo, "endedAt" | "queuedAt" | "startedAt"> {
  const queuedAt =
    execution?.timestamps.queuedAt ?? isoOf(stored?.timestamps.createdAt);
  const startedAt =
    execution?.timestamps.startedAt ?? isoOf(stored?.timestamps.startedAt);
  const endedAt = TERMINAL_RUN_STATUSES.has(status)
    ? (isoOf(stored?.timestamps.completedAt ?? stored?.timestamps.failedAt) ??
      execution?.timestamps.settledAt)
    : undefined;
  return {
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(queuedAt === undefined ? {} : { queuedAt }),
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

type RunDetails = Omit<RunInfo, "status">;

interface Held {
  completion: Promise<void>;
  readonly record: RunDetails;
}

const SETTLED = Promise.resolve();

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function named(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function sessionOf(input: unknown): SessionRef | undefined {
  const session = field(input, "session");
  return named(field(session, "id")) === undefined
    ? undefined
    : (session as SessionRef);
}

function correlationSession(
  correlation: Readonly<Record<string, string>> | undefined
): SessionRef | undefined {
  const raw = correlation?.agentSession;
  if (raw === undefined) {
    return undefined;
  }
  try {
    return sessionOf({ session: JSON.parse(raw) as unknown });
  } catch {
    return undefined;
  }
}

function identity(
  runId: string,
  name: string,
  input: unknown,
  correlation?: Readonly<Record<string, string>>
): RunDetails {
  if (name !== AGENT_DISPATCH) {
    return { kind: "workflow", name, runId };
  }
  const session = sessionOf(input) ?? correlationSession(correlation);
  return {
    kind: "agent",
    name:
      named(field(input, "agentId")) ??
      named(field(input, "agent")) ??
      named(correlation?.agentId) ??
      name,
    runId,
    ...(session === undefined ? {} : { session }),
  };
}

function applyOutput(record: RunDetails, output: unknown): void {
  if (record.kind !== "agent") {
    record.output = output;
    return;
  }
  const text = field(output, "text");
  record.output = field(output, "output");
  if (typeof text === "string") {
    record.text = text;
  }
}

function storedDetails(
  runId: string,
  stored: RunRecord | undefined,
  execution: ExecutionRun | undefined
): RunDetails | undefined {
  const known =
    stored ?? (execution?.kind === "workflow" ? execution : undefined);
  if (known === undefined) {
    return;
  }
  const record = identity(
    runId,
    stored?.step ?? execution?.name ?? "",
    stored?.input ?? execution?.input,
    execution?.correlation
  );
  const status = stored?.status ?? execution?.status ?? "queued";
  if (stored?.status === "complete") {
    applyOutput(record, stored.output);
    return record;
  }
  const error = stored?.error?.message ?? execution?.error?.message;
  if (
    error !== undefined &&
    (SETTLED_EXECUTION_STATUSES as ReadonlySet<string>).has(status)
  ) {
    record.error = error;
  }
  return record;
}

function inside(parent: string, path: string): boolean {
  const rest = relative(parent, path);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

export class BackgroundRuns {
  readonly #engine: Engine;
  readonly #catalog: Catalog;
  readonly #held = new Map<string, Held>();
  readonly #identities = new Map<
    string,
    Pick<RunInfo, "kind" | "name" | "session">
  >();
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
    const opened = this.#sessions.get(input.session.id);
    const session = opened ?? (await this.#reopen(input));
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
      if (!opened) {
        this.#sessions.delete(input.session.id);
      }
    }
  }

  async #reopen(input: AgentInput): Promise<Session<Output.Output>> {
    const session = await this.#engine.agents.session(
      await this.#agent(input, input.agentId),
      await this.#sessionOptions({ ...input, session: input.session })
    );
    if (this.#sessions.has(session.ref.id)) {
      throw new Error("this session already has an active agent dispatch");
    }
    this.#sessions.set(session.ref.id, session);
    return session;
  }

  async #agent(
    options: DispatchOptions,
    id?: string
  ): Promise<AgentLike<Output.Output>> {
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
    ): AgentDefinition<Output.Output> => {
      const { instructions } = options;
      if (instructions === undefined) {
        return { ...base, ...route };
      }
      const append = (prompt?: string) =>
        [prompt, instructions].filter(Boolean).join("\n\n");
      const render = base[AGENT_PROMPT];
      return {
        ...base,
        ...route,
        ...(render === undefined
          ? {}
          : { [AGENT_PROMPT]: (harness: string) => append(render(harness)) }),
        prompt: append(declared ? base.prompt : undefined),
      };
    };
    return declared
      ? await dispatched(declared, route, overlay)
      : overlay({
          id: id ?? `agent-${crypto.randomUUID()}`,
          kind: "agent",
          prompt: "Complete the user's task.",
        });
  }

  async #inWorktree(path: string): Promise<boolean> {
    const home = await realpath(this.#engine.worktrees).catch(() => undefined);
    if (home === undefined || !inside(home, path)) {
      return false;
    }
    let listed: readonly { readonly root: string }[];
    try {
      listed = await this.#engine.workspaces.current.git.worktrees();
    } catch {
      return false;
    }
    for (const worktree of listed) {
      const top = await realpath(worktree.root).catch(() => undefined);
      if (top !== undefined && inside(home, top) && inside(top, path)) {
        return true;
      }
    }
    return false;
  }

  async #workingDirectory(cwd: string): Promise<string> {
    const { root } = this.#engine.bindings;
    const asked = resolve(root, cwd);
    const refuse = (reason: string): Error =>
      new Error(
        `cwd "${asked}" ${reason}; dispatch_agent starts only in a directory inside the workspace root ${root} or one of its Marbles worktrees`
      );
    const real = await realpath(asked).catch(() => undefined);
    if (real === undefined) {
      throw refuse("does not exist");
    }
    if (!(await stat(real)).isDirectory()) {
      throw refuse("is not a directory");
    }
    const top = await realpath(root).catch(() => resolve(root));
    if (inside(top, real) || (await this.#inWorktree(real))) {
      return real;
    }
    throw refuse(
      real === asked
        ? "is outside the workspace root"
        : `resolves to ${real}, outside the workspace root`
    );
  }

  async #sessionOptions(options: DispatchOptions): Promise<SessionOptions> {
    return {
      ...(options.compaction === undefined
        ? {}
        : { compaction: options.compaction }),
      ...(options.cwd === undefined
        ? {}
        : { cwd: await this.#workingDirectory(options.cwd) }),
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
      ...(options.session === undefined ? {} : { session: options.session }),
    };
  }

  definitions(): ReturnType<Engine["definitions"]> {
    return this.#engine
      .definitions()
      .filter((entry) => entry.name !== AGENT_DISPATCH);
  }

  async startWorkflow(
    name: string,
    input: unknown,
    { key }: EnqueueOptions = {}
  ): Promise<DispatchInfo> {
    this.#closing.signal.throwIfAborted();
    if (key !== undefined && key.trim() === "") {
      throw new TypeError("key must not be blank");
    }
    if (!this.definitions().some((entry) => entry.name === name)) {
      throw new Error(`no workflow or step named "${name}"`);
    }
    const launched = await this.#engine.launch(
      name,
      input,
      key === undefined
        ? undefined
        : { idempotencyKey: idempotencyKeyOf(name, key) }
    );
    if (
      this.#held.has(launched.id) ||
      (key !== undefined && launched.reused === true)
    ) {
      launched.result.catch(() => undefined);
      const {
        kind,
        name: runName,
        runId,
        status,
      } = await this.get(launched.id);
      return { kind, name: runName, runId, status };
    }
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
    const agent = await this.#agent(options);
    const session = await this.#engine.agents.session(
      agent,
      await this.#sessionOptions(options)
    );
    this.#closing.signal.throwIfAborted();
    if (this.#sessions.has(session.ref.id)) {
      throw new Error("this session already has an active agent dispatch");
    }
    this.#sessions.set(session.ref.id, session);
    try {
      const launched = await this.#engine.launch<AgentResult>(
        AGENT_DISPATCH,
        {
          ...options,
          agentId: agent.id,
          session: session.ref,
        },
        {
          correlation: {
            agentId: agent.id,
            agentSession: JSON.stringify(session.ref),
          },
        }
      );
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
    return {
      ...meta,
      runId: record.runId,
      status: runStatus((await this.#lookup(record.runId)).status),
    };
  }

  async get(runId: string): Promise<RunInfo> {
    const { completion, record, status, times } = await this.#lookup(runId);
    if (TERMINAL_RUN_STATUSES.has(status)) {
      await completion;
    }
    return {
      ...record,
      ...times,
      status: runStatus(status),
    };
  }

  async list(query: RunListQuery = {}): Promise<RunPage> {
    const runs = [...(await this.#engine.readRuns())]
      .reverse()
      .filter((view) => view.kind === "workflow")
      .map((view) => this.#summary(view))
      .filter(matching(query));
    const cursor = query.cursor ?? 0;
    const end =
      cursor + Math.min(query.limit ?? DEFAULT_RUN_PAGE, MAX_RUN_PAGE);
    return {
      items: runs.slice(cursor, end),
      ...(end < runs.length ? { nextCursor: end } : {}),
      total: runs.length,
    };
  }

  #summary(view: RunView): RunSummary {
    const known =
      this.#held.get(view.id)?.record ??
      (view.input === undefined ? this.#identities.get(view.id) : undefined);
    const { kind, name, session } =
      known ??
      identity(
        view.id,
        view.name,
        view.input,
        this.#engine.executions.get(view.id)?.correlation
      );
    return {
      ...(view.endedAt === undefined ? {} : { endedAt: view.endedAt }),
      ...(view.error === undefined ? {} : { error: view.error }),
      id: view.id,
      kind,
      name,
      queuedAt: view.queuedAt,
      ...(session === undefined ? {} : { session }),
      ...(view.startedAt === undefined ? {} : { startedAt: view.startedAt }),
      status: listedStatus(view.status),
    };
  }

  async #lookup(runId: string) {
    const stored = (await this.#engine.runs()).find((run) => run.id === runId);
    const execution = this.#engine.executions.get(runId);
    const status = stored?.status ?? execution?.status;
    const held = this.#held.get(runId);
    const record = held?.record ?? this.#derive(runId, stored, execution);
    if (!record) {
      throw new Error(`no run "${runId}" in this host`);
    }
    if (status === undefined) {
      throw new Error(`no engine run "${runId}"`);
    }
    const normalized = status === "interrupted" ? ("failed" as const) : status;
    return {
      completion: held?.completion ?? SETTLED,
      record,
      status: normalized,
      times: snapshotTimes(normalized, stored, execution),
    };
  }

  async cancel(runId: string): Promise<RunInfo> {
    if (!TERMINAL_RUN_STATUSES.has((await this.#lookup(runId)).status)) {
      try {
        await this.#engine.cancel(runId);
      } catch (error) {
        if (!TERMINAL_RUN_STATUSES.has((await this.#lookup(runId)).status)) {
          throw error;
        }
      }
    }
    return this.get(runId);
  }

  #derive(
    runId: string,
    stored: RunRecord | undefined,
    execution: ExecutionRun | undefined
  ): RunDetails | undefined {
    const record = storedDetails(runId, stored, execution);
    if (!record) {
      return;
    }
    if ((stored?.input ?? execution?.input) === undefined) {
      return { ...record, ...this.#identities.get(runId) };
    }
    if (!stored) {
      const { kind, name, session } = record;
      this.#identities.set(runId, {
        kind,
        name,
        ...(session === undefined ? {} : { session }),
      });
    }
    return record;
  }

  #ownedHere(runId: string): boolean {
    const run = this.#engine.executions.get(runId);
    return run?.owner === undefined || sameProcess(run.owner, thisProcess());
  }

  async close(): Promise<void> {
    this.#closing.abort(new Error("background runs are closed"));
    await Promise.all(
      [...this.#held.keys()]
        .filter((runId) => this.#ownedHere(runId))
        .map((runId) => this.cancel(runId))
    );
    await Promise.all([...this.#held.values()].map((held) => held.completion));
  }
}
