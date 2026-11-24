import type { JsonValue } from "@foundry/lib/json";
import type {
  ErrorShape,
  Suspension as QueuedSuspension,
  QueueEvent,
  Run,
  RunHandler,
  RunId,
  SuspensionId,
} from "@foundry/queue";
import { createQueueClient, type QueueClient } from "@foundry/queue/client";
import { QueueStore, type QueueStoreService } from "@foundry/queue/store";
import type { ChannelMessage } from "@foundry/workflows/channels";
import type { Runnable } from "@foundry/workflows/definitions";
import type { BaseContext } from "@foundry/workflows/executable";
import { parseSuspensionOccurrenceKey } from "@foundry/workflows/executable";
import {
  restoreWorkflow,
  workflowHandler,
} from "@foundry/workflows/queue-handler";
import type { Step } from "@foundry/workflows/step";
import {
  Workflow,
  type WorkflowResult,
  type WorkflowState,
} from "@foundry/workflows/workflow";
import { Effect, Layer } from "effect";
import { storableJson } from "~/lib/state/json";
import { isRunId, surfaced } from "~/lib/workflow-runs";

export interface RunExecution {
  readonly runId: string;
}

export type Factory<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> = ReturnType<Step<I, O, X>["factory"]>;

export type RunFactory<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> = (
  input: unknown,
  execution: RunExecution
) => Runnable<I, O, X> | Promise<Runnable<I, O, X>>;

export interface HeldWorkflow {
  abort(reason?: unknown): void;
  cancel(reason?: string): Promise<void>;
  result(): Promise<WorkflowResult<unknown>>;
  readonly root: {
    readonly path: readonly string[];
    readonly signal: AbortSignal;
    subscribe(signal?: AbortSignal): ReadableStream<ChannelMessage>;
  };
  readonly state: WorkflowState;
  readonly status: WorkflowState["status"];
}

interface Definition {
  adopt(
    input: unknown,
    runId: string,
    checkpoint: JsonValue | undefined
  ): Promise<HeldWorkflow>;
  forget(runId: string): void;
  open(input: unknown, runId: string): Promise<HeldWorkflow>;
  readonly registered: Promise<void>;
}

export interface LiveRun {
  readonly id: string;
  result(): Promise<WorkflowResult<unknown>>;
  readonly workflow: HeldWorkflow;
}

export interface Suspension {
  readonly id: string;
  readonly kind: string;
  readonly request: JsonValue;
  readonly revision: number;
  readonly runId: string;
  readonly status: QueuedSuspension["state"]["kind"];
  readonly stepPath: readonly string[];
}

export interface RunOptions {
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly triggerId?: string;
}

type RunSignal = "resumed" | "suspended";

interface Held {
  readonly definition: Definition;
  readonly settled: PromiseWithResolvers<WorkflowResult<unknown>>;
  readonly workflow: HeldWorkflow;
}

const TERMINAL: ReadonlySet<string> = new Set([
  "complete",
  "failed",
  "cancelled",
]);

const SETTLING: ReadonlySet<QueueEvent["type"]> = new Set([
  "run.cancelled",
  "run.completed",
  "run.failed",
  "run.interrupted",
]);

const SIGNALS: Partial<Record<QueueEvent["type"], RunSignal>> = {
  "run.resumed": "resumed",
  "run.suspended": "suspended",
};

const suspensionOf = (suspension: QueuedSuspension): Suspension => ({
  id: suspension.id,
  kind: suspension.kind,
  request: suspension.request,
  revision: suspension.revision,
  runId: suspension.runId,
  status: suspension.state.kind,
  stepPath: parseSuspensionOccurrenceKey(suspension.key)?.stepPath ?? [],
});

const outcomeOf = ({ state }: Run): WorkflowResult<unknown> => {
  switch (state.kind) {
    case "complete":
      return { status: "complete", value: state.output };
    case "failed":
      return { error: new Error(state.error.message), status: "failed" };
    case "interrupted":
      return { error: new Error(state.reason), status: "failed" };
    case "cancelled":
      return state.reason === undefined
        ? { status: "cancelled" }
        : { reason: state.reason, status: "cancelled" };
    default:
      return { status: "cancelled" };
  }
};

const requireRunId = (id: string): RunId => {
  if (!isRunId(id)) {
    throw new TypeError(`"${id}" is not a run id; run ids start with "rn-"`);
  }
  return id;
};

const isSuspensionId = (id: string): id is SuspensionId => id.startsWith("su-");

const hostTurn = Effect.async<void>((resume) => {
  const turn = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(turn));
});

const surfacing = <T>(call: Promise<T>): Promise<T> =>
  call.catch((error: unknown) => Promise.reject(surfaced(error)));

export class WorkflowQueue {
  readonly #client: QueueClient;
  readonly #definitions = new Map<string, Definition>();
  readonly #held = new Map<string, Held>();
  readonly #listeners = new Map<RunSignal, Set<(runId: string) => void>>([
    ["resumed", new Set()],
    ["suspended", new Set()],
  ]);
  readonly #store: QueueStoreService;
  readonly #unsubscribe: () => void;

  constructor(store: QueueStoreService) {
    this.#store = store;
    this.#client = createQueueClient({
      defaultLimit: Number.POSITIVE_INFINITY,
      store: Layer.succeed(QueueStore, store),
    });
    this.#unsubscribe = this.#client.subscribe((event) => this.#observe(event));
  }

  register<I, O, X extends BaseContext>(
    name: string,
    factory: RunFactory<I, O, X>
  ): void {
    if (this.#definitions.has(name)) {
      throw new Error(`"${name}" is already registered`);
    }
    const live = new Map<string, Workflow<I, O, X>>();
    const materialize = async (input: unknown, runId: string) => {
      const made = await factory(input, { runId });
      const workflow =
        made.kind === "step" ? Workflow.attach(made, made.input) : made;
      workflow.setRunId(runId);
      live.set(runId, workflow);
      return workflow;
    };
    const handler = workflowHandler<I, O, X>(async (input, { run }) => {
      const held = live.get(run.id);
      if (held !== undefined) {
        return held;
      }
      const workflow = await materialize(input, run.id);
      this.#hold(run.id, definition, workflow);
      return workflow;
    });
    const registered = this.#client.register(name, this.#admitted(handler));
    registered.catch(() => undefined);
    const definition: Definition = {
      adopt: async (input, runId, checkpoint) => {
        const workflow = await materialize(input, runId);
        await restoreWorkflow(workflow, checkpoint);
        await workflow.seedState({ status: "suspended" });
        return workflow;
      },
      forget: (runId) => live.delete(runId),
      open: materialize,
      registered,
    };
    this.#definitions.set(name, definition);
  }

  on(signal: RunSignal, listener: (runId: string) => void): () => void {
    const listeners = this.#listeners.get(signal);
    listeners?.add(listener);
    return () => listeners?.delete(listener);
  }

  async run(
    name: string,
    input: unknown,
    options: RunOptions
  ): Promise<LiveRun> {
    const runId = requireRunId(options.runId);
    const withdrawn = () => {
      if (options.signal?.aborted) {
        throw new Error(`Run ${runId} was cancelled before it was dispatched`, {
          cause: options.signal.reason,
        });
      }
    };
    withdrawn();
    if (this.#held.has(runId)) {
      throw new Error(`Run ${runId} already exists`);
    }
    const stored = storableJson(`the input of run ${runId}`, input ?? null);
    const definition = this.#definition(name);
    await definition.registered;
    const workflow = await definition.open(input, runId);
    if (this.#held.has(runId)) {
      throw new Error(`Run ${runId} already exists`);
    }
    const live = this.#hold(runId, definition, workflow);
    try {
      withdrawn();
    } catch (error) {
      this.forget(runId);
      throw error;
    }
    try {
      await surfacing(
        this.#client.submit({
          handler: { name },
          input: stored,
          links:
            options.triggerId === undefined
              ? {}
              : { triggerId: options.triggerId },
          runId,
        })
      );
    } catch (error) {
      this.forget(runId);
      throw error;
    }
    return live;
  }

  async adopt(runId: string): Promise<LiveRun | null> {
    const run = isRunId(runId)
      ? await surfacing(this.#client.getRun(runId))
      : undefined;
    const job = run && (await surfacing(this.#client.getJob(run.jobId)));
    if (run === undefined || job === undefined) {
      return null;
    }
    if (run.state.kind !== "suspended") {
      throw new Error(
        `Run ${runId} is ${run.state.kind}, not suspended; only a suspended run is taken on after start`
      );
    }
    const definition = this.#definition(job.handler.name);
    await definition.registered;
    await surfacing(this.#client.adopt(run.id));
    const workflow = await definition.adopt(job.input, runId, run.checkpoint);
    return this.#hold(runId, definition, workflow);
  }

  forget(runId: string): void {
    this.#held.get(runId)?.definition.forget(runId);
    this.#held.delete(runId);
  }

  async cancelRun(runId: string, reason?: string): Promise<void> {
    if (isRunId(runId)) {
      await surfacing(this.#client.cancel(runId, reason));
    }
  }

  async abandonRun(runId: string, error: ErrorShape): Promise<void> {
    await surfacing(this.#client.abandon(requireRunId(runId), error));
  }

  async suspensions(query: {
    readonly kind?: string;
    readonly runId: string;
  }): Promise<readonly Suspension[]> {
    if (!isRunId(query.runId)) {
      return [];
    }
    const pending = await surfacing(
      this.#client.listSuspensions({
        runId: query.runId,
        state: "pending",
      })
    );
    return pending
      .filter(
        (suspension) =>
          query.kind === undefined || suspension.kind === query.kind
      )
      .map(suspensionOf);
  }

  async suspension(id: string): Promise<Suspension | undefined> {
    const suspension = isSuspensionId(id)
      ? await surfacing(this.#client.getSuspension(id))
      : undefined;
    return suspension && suspensionOf(suspension);
  }

  async resolve(
    id: string,
    value: JsonValue,
    options: { readonly expectedRevision: number }
  ): Promise<void> {
    if (!isSuspensionId(id)) {
      throw new TypeError(`"${id}" is not a suspension id`);
    }
    await surfacing(this.#client.resolveSuspension(id, value, options));
  }

  drain(): Promise<void> {
    return this.#client.drain();
  }

  async stop(): Promise<void> {
    this.#unsubscribe();
    await this.#client.dispose();
  }

  #admitted(handler: RunHandler): RunHandler {
    return (context) =>
      Effect.zipRight(hostTurn, this.#store.getRun(context.run.id)).pipe(
        Effect.mapError(
          (error): ErrorShape => ({ message: String(error), name: "store" })
        ),
        Effect.flatMap((run) =>
          run?.state.kind === "running" ? handler(context) : Effect.interrupt
        )
      );
  }

  #definition(name: string): Definition {
    const definition = this.#definitions.get(name);
    if (definition === undefined) {
      throw new Error(`Definition "${name}" is not registered`);
    }
    return definition;
  }

  #hold(
    runId: string,
    definition: Definition,
    workflow: HeldWorkflow
  ): LiveRun {
    const held: Held = {
      definition,
      settled: Promise.withResolvers<WorkflowResult<unknown>>(),
      workflow,
    };
    this.#held.set(runId, held);
    return { id: runId, result: () => held.settled.promise, workflow };
  }

  #observe(event: QueueEvent): void {
    if (!("run" in event)) {
      return;
    }
    const { run } = event;
    const signal = SIGNALS[event.type];
    if (signal !== undefined) {
      for (const listener of this.#listeners.get(signal) ?? []) {
        listener(run.id);
      }
      return;
    }
    const held = this.#held.get(run.id);
    if (!SETTLING.has(event.type) || held === undefined) {
      return;
    }
    this.forget(run.id);
    const { settled, workflow } = held;
    if (event.type === "run.failed" || event.type === "run.interrupted") {
      const outcome = outcomeOf(run);
      if (!TERMINAL.has(workflow.status)) {
        workflow.abort(outcome.status === "failed" ? outcome.error : undefined);
      }
      settled.resolve(outcome);
      return;
    }
    if (TERMINAL.has(workflow.status)) {
      workflow.result().then(settled.resolve, settled.reject);
      return;
    }
    const outcome = outcomeOf(run);
    if (outcome.status !== "cancelled") {
      workflow.abort(outcome.status === "failed" ? outcome.error : undefined);
      settled.resolve(outcome);
      return;
    }
    const resolve = () => settled.resolve(outcome);
    workflow.cancel(outcome.reason).then(resolve, resolve);
  }
}
