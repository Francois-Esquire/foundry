import type { JsonValue } from "@foundry/lib/json";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import type {
  ErrorShape,
  Suspension as QueuedSuspension,
  QueueEvent,
  Run,
  RunId,
  SuspensionId,
} from "@foundry/queue";
import { createQueueClient, type QueueClient } from "@foundry/queue/client";
import { QueueStore, type QueueStoreService } from "@foundry/queue/store";
import type { ChannelMessage } from "@foundry/workflows/channels";
import type { Runnable } from "@foundry/workflows/definitions";
import type { BaseContext } from "@foundry/workflows/executable";
import { parseSuspensionOccurrenceKey } from "@foundry/workflows/executable";
import { runResultOf, workflowHandler } from "@foundry/workflows/queue-handler";
import type { Step } from "@foundry/workflows/step";
import {
  Workflow,
  type WorkflowResult,
  type WorkflowState,
} from "@foundry/workflows/workflow";
import { Layer } from "effect";
import { storableJson } from "~/lib/state/json";
import { isRunId, surfaced } from "~/lib/workflow-runs";

export interface RunExecution {
  readonly resolutions?: ReadonlyMap<string, JsonValue>;
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
  result(): Promise<WorkflowResult<unknown>>;
  readonly root: {
    readonly path: readonly string[];
    readonly signal: AbortSignal;
    subscribe(signal?: AbortSignal): ReadableStream<ChannelMessage>;
  };
  readonly state: WorkflowState;
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
  readonly parentRunId?: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly triggerId?: string;
}

export interface Attempts {
  prepare(name: string, runId: string): Promise<void>;
  started(runId: string, workflow: HeldWorkflow): void;
}

type RunSignal = "suspended";

interface Definition {
  first(input: unknown, runId: string): Promise<void>;
  forget(runId: string): void;
  readonly registered: Promise<void>;
}

const SIGNALS: Partial<Record<QueueEvent["type"], RunSignal>> = {
  "run.suspended": "suspended",
};

const UNWATCHED: Attempts = {
  prepare: () => Promise.resolve(),
  started: () => undefined,
};

const SETTLED_JOBS: ReadonlySet<string> = new Set([
  "complete",
  "failed",
  "cancelled",
]);

const suspensionOf = (suspension: QueuedSuspension): Suspension => ({
  id: suspension.id,
  kind: suspension.kind,
  request: suspension.request,
  revision: suspension.revision,
  runId: suspension.runId,
  status: suspension.state.kind,
  stepPath: parseSuspensionOccurrenceKey(suspension.key)?.stepPath ?? [],
});

const requireRunId = (id: string): RunId => {
  if (!isRunId(id)) {
    throw new TypeError(`"${id}" is not a run id; run ids start with "rn-"`);
  }
  return id;
};

const isSuspensionId = (id: string): id is SuspensionId => id.startsWith("su-");

const surfacing = <T>(call: Promise<T>): Promise<T> =>
  call.catch((error: unknown) => Promise.reject(surfaced(error)));

const latest = (runs: readonly Run[]): Run | undefined =>
  runs.reduce<Run | undefined>(
    (last, run) =>
      last === undefined || run.attempt > last.attempt ? run : last,
    undefined
  );

export class WorkflowQueue {
  readonly #attached = new Map<string, HeldWorkflow>();
  readonly #attempts: Attempts;
  readonly #client: QueueClient;
  readonly #definitions = new Map<string, Definition>();
  readonly #listeners = new Map<RunSignal, Set<(runId: string) => void>>([
    ["suspended", new Set()],
  ]);
  readonly #unsubscribe: () => void;

  constructor(store: QueueStoreService, attempts: Attempts = UNWATCHED) {
    this.#attempts = attempts;
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
    const attempts = this.#attempts;
    const first = new Map<string, Workflow<I, O, X>>();
    const materialize = async (
      input: unknown,
      runId: string,
      resolutions?: ReadonlyMap<string, JsonValue>
    ) => {
      const made = await factory(input, {
        runId,
        ...(resolutions === undefined ? {} : { resolutions }),
      });
      const workflow =
        made.kind === "step" ? Workflow.attach(made, made.input) : made;
      workflow.setRunId(runId);
      return workflow;
    };
    const handler = workflowHandler<I, O, X>(
      async (input, { run }) => {
        const ready = first.get(run.id);
        if (ready !== undefined) {
          first.delete(run.id);
          return ready;
        }
        await attempts.prepare(name, run.id);
        return await materialize(input, run.id, await this.#resolved(run.id));
      },
      {
        onFinish: (runId, workflow) => {
          if (this.#attached.get(runId) === workflow) {
            this.#attached.delete(runId);
          }
        },
        onStart: (runId, workflow) => {
          this.#attached.set(runId, workflow);
          attempts.started(runId, workflow);
        },
      }
    );
    const registered = this.#client.register(name, handler);
    registered.catch(() => undefined);
    this.#definitions.set(name, {
      first: async (input, runId) => {
        first.set(runId, await materialize(input, runId));
      },
      forget: (runId) => first.delete(runId),
      registered,
    });
  }

  on(signal: RunSignal, listener: (runId: string) => void): () => void {
    const listeners = this.#listeners.get(signal);
    listeners?.add(listener);
    return () => listeners?.delete(listener);
  }

  attached(runId: string): HeldWorkflow | undefined {
    return this.#attached.get(runId);
  }

  async run(name: string, input: unknown, options: RunOptions): Promise<void> {
    const runId = requireRunId(options.runId);
    const withdrawn = () => {
      if (options.signal?.aborted) {
        throw new Error(`Run ${runId} was cancelled before it was dispatched`, {
          cause: options.signal.reason,
        });
      }
    };
    withdrawn();
    const stored = storableJson(`the input of run ${runId}`, input ?? null);
    const definition = this.#definitions.get(name);
    if (definition === undefined) {
      throw new Error(`Definition "${name}" is not registered`);
    }
    await definition.registered;
    await definition.first(input, runId);
    try {
      withdrawn();
      await this.#submit(name, stored, options);
    } catch (error) {
      definition.forget(runId);
      throw error;
    }
  }

  async #submit(
    name: string,
    input: JsonValue,
    options: RunOptions
  ): Promise<void> {
    await surfacing(
      this.#client.submit({
        handler: { name },
        input,
        links: {
          ...(options.parentRunId !== undefined && isRunId(options.parentRunId)
            ? { parentRunId: options.parentRunId }
            : {}),
          ...(options.triggerId === undefined
            ? {}
            : { triggerId: options.triggerId }),
        },
        runId: requireRunId(options.runId),
      })
    );
  }

  async settled(runId: string): Promise<WorkflowResult<unknown>> {
    const run = await surfacing(this.#client.getRun(requireRunId(runId)));
    if (run === undefined) {
      throw new Error(`Run ${runId} is not stored`);
    }
    const job = await surfacing(this.#client.awaitJob(run.jobId));
    const last = latest(
      await surfacing(this.#client.listRuns({ jobId: job.id }))
    );
    return last === undefined ? { status: "cancelled" } : runResultOf(last);
  }

  async hasSettled(runId: string): Promise<boolean> {
    const run = isRunId(runId)
      ? await surfacing(this.#client.getRun(runId))
      : undefined;
    const job = run && (await surfacing(this.#client.getJob(run.jobId)));
    return job === undefined || SETTLED_JOBS.has(job.state.kind);
  }

  async stateOf(runId: string): Promise<Run["state"]["kind"] | undefined> {
    const run = isRunId(runId)
      ? await surfacing(this.#client.getRun(runId))
      : undefined;
    return run?.state.kind;
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

  async retire(successor: ProcessIdentity): Promise<void> {
    await surfacing(this.#client.retire(successor));
  }

  drain(): Promise<void> {
    return this.#client.drain();
  }

  async stop(): Promise<void> {
    this.#unsubscribe();
    await this.#client.dispose();
  }

  async #resolved(runId: RunId): Promise<ReadonlyMap<string, JsonValue>> {
    const resolved = await surfacing(
      this.#client.listSuspensions({ runId, state: "resolved" })
    );
    return new Map(
      resolved.flatMap((suspension) =>
        suspension.state.kind === "resolved"
          ? [[suspension.key, suspension.state.value] as const]
          : []
      )
    );
  }

  #observe(event: QueueEvent): void {
    const signal = SIGNALS[event.type];
    if (signal === undefined || !("run" in event)) {
      return;
    }
    for (const listener of this.#listeners.get(signal) ?? []) {
      listener(event.run.id);
    }
  }
}
