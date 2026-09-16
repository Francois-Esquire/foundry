import type { Config } from "@foundry/lib/config";
import { Effect, Exit, Option, Schema, Scope } from "effect";
import { contributeQueueConfig } from "./config";
import {
  DefinitionNotRegisteredError,
  OrchestratorNotStartedError,
  RecoverableDefinitionMissingError,
  RunNotFoundError,
} from "./errors";
import type { BaseContext } from "./executable";
import { ExecutionParticipants } from "./execution-participants";
import type { CreateJobOptions } from "./job-lifecycle";
import { JobLifecycle } from "./job-lifecycle";
import type { OrchestratorLogger } from "./logger";
import { BaseOrchestratorLogger } from "./logger";
import type { ExecutionPersistence } from "./persistence";
import { orchestratorStoreFromPersistence } from "./persistence-compatibility";
import type {
  DispatchedWorkflow,
  DispatchOptions,
  QueueEvent,
  QueueEventPayload,
} from "./queue";
import { Queue } from "./queue";
import type { ObserveRunOptions, RunObservation } from "./run-observation";
import { RunObservationJournal } from "./run-observation";
import type { StepSnapshot } from "./snapshot";
import { StepSnapshotSchema } from "./snapshot";
import type { Step } from "./step";
import type {
  DefinitionReference,
  DirectRunLinks,
  Extensions,
  JobLinks,
  JobQuery,
  JobRecord,
  JsonValue,
  OrchestratorStore,
  Page,
  QueueRecord,
  RunFramePayload,
  RunLinks,
  RunPage,
  RunQuery,
  RunRecord,
  SuspensionQuery,
  SuspensionRecord,
} from "./store";
import {
  createExtensions,
  InMemoryOrchestratorStore,
  JsonValueSchema,
} from "./store";
import type { ResolveSuspensionOptions } from "./suspension-lifecycle";
import { SuspensionLifecycle } from "./suspension-lifecycle";
import type { TelemetryLogEntry } from "./telemetry";
import type { Unsubscribe } from "./types";
import { Workflow } from "./workflow";

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function collectPageItems<T>(
  list: (page: { limit: number; offset: number }) => Promise<Page<T>>
): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await list({ limit: 200, offset });
    items.push(...page.items);
    if (page.nextOffset === null) {
      return items;
    }
    offset = page.nextOffset;
  }
}

/**
 * Anything dispatchable by name. Workflows go to the queue as-is;
 * Steps get auto-wrapped into a one-shot Workflow on resolve.
 */
export type Runnable<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> = Step<I, O, X> | Workflow<I, O, X>;

export type { DirectRunLinks } from "./store";

/** Stable identity and correlation supplied before registered work is built. */
export interface RunExecutionContext {
  /**
   * Durably reserve a named side effect before executing it. The first claim
   * returns true; duplicate or recovered claims for this Run return false.
   */
  readonly claimEffect: (key: string, metadata?: JsonValue) => Promise<boolean>;
  readonly definition: DefinitionReference;
  /** Publish durable domain output after execution has begun. */
  readonly emitOutput: (value: JsonValue) => Promise<void>;
  readonly links: RunLinks;
  readonly runId: string;
}

/** Narrow read-only Queue state intended for operational diagnostics. */
export interface QueueDiagnostic {
  readonly createdAt: number;
  readonly id: string;
  readonly lastError: QueueRecord["lastError"];
  readonly name: string;
  readonly status: QueueRecord["status"];
}

/**
 * Builds a Runnable from raw input. Factories are ordinary TypeScript:
 * either synchronous or Promise-returning. Effect remains an internal
 * implementation detail of the orchestrator.
 */
export type Factory<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> = (
  input: I,
  context?: RunExecutionContext
) => Runnable<I, O, X> | Promise<Runnable<I, O, X>>;

/**
 * Normalise a Factory's return value into an Effect that yields the
 * Runnable. Promise-returning factories are wrapped with `Effect.promise`;
 * synchronous returns are wrapped with `Effect.succeed`.
 */
function factoryToEffect<I, O, X extends BaseContext = BaseContext>(
  factory: Factory<I, O, X>,
  input: I,
  context: RunExecutionContext
): Effect.Effect<Runnable<I, O, X>> {
  const result = factory(input, context);
  if (result instanceof Promise) {
    return Effect.promise(() => result);
  }
  return Effect.succeed(result);
}

/**
 * Validating decoder for the persisted `runs.metadata.workflow.steps`
 * blob. Reuses the canonical {@link StepSnapshotSchema} so recovery
 * seeding can't drift from the live snapshot shape. Returns `None` on
 * any structural mismatch (or absent blob) so the caller falls back to
 * running the workflow from the top.
 */
const decodeSeedSteps = Schema.decodeUnknownOption(
  Schema.Record({ key: Schema.String, value: StepSnapshotSchema })
);

// ── Registry: name → factory ──
// Name is the persistence anchor. `runs.step` stores it; cold restart
// calls `registry.resolve(name)` to rebuild. Steps and Workflows share
// one namespace — duplicate registrations throw.

export class Registry {
  readonly #factories = new Map<string, Factory>();

  register<I, O, X extends BaseContext = BaseContext>(
    name: string,
    factory: Factory<I, O, X>
  ): void {
    if (this.#factories.has(name)) {
      throw new Error(`already registered: "${name}"`);
    }
    // Erase the context type for storage. `Factory` is invariant in `X`
    // (its returned `Runnable` embeds `execute`), so this is a deliberate
    // `unknown` round-trip — the registry namespace is context-agnostic;
    // resolution re-applies whatever `X` the caller asks for.
    this.#factories.set(name, factory as unknown as Factory);
  }

  resolve<I = unknown, O = unknown, X extends BaseContext = BaseContext>(
    name: string
  ): Factory<I, O, X> {
    const factory = this.#factories.get(name);
    if (!factory) {
      throw new DefinitionNotRegisteredError(name);
    }
    return factory as unknown as Factory<I, O, X>;
  }

  has(name: string): boolean {
    return this.#factories.has(name);
  }

  names(): readonly string[] {
    return [...this.#factories.keys()];
  }
}

export interface OrchestratorOptions {
  readonly admissionParticipant?: (input: {
    readonly job: JobRecord;
    readonly run: RunRecord;
    readonly persistence: ExecutionPersistence;
  }) => Promise<JsonValue>;
  readonly cancellationParticipant?: (input: {
    readonly run: RunRecord;
    readonly persistence: ExecutionPersistence;
  }) => Promise<RunRecord | null>;
  /**
   * Shared config registry. The orchestrator self-contributes its
   * `queue` slice (idempotent) at construction and reads
   * `queue.concurrency` and `queue.defaultName` from it. Composers
   * wanting non-default values call `contributeQueueConfig(config,
   * { ... })` on the registry before constructing the orchestrator.
   */
  readonly config: Config;
  /** Optional lifecycle logger. */
  readonly logger?: OrchestratorLogger;
  /** Preferred composed persistence capability. */
  readonly persistence?: ExecutionPersistence;
  /** Host-owned JSON-safe annotations persisted with the default queue. */
  readonly queueExtensions?: Extensions;
  /** Pre-populated registry, or omit to start empty. */
  readonly registry?: Registry;
  /** Persistence boundary. Defaults to the in-memory reference store. */
  readonly store?: OrchestratorStore;
}

export interface RunOptions {
  /** Host-owned JSON-safe annotations persisted with this run. */
  readonly extensions?: Extensions;
  /** Cross-domain correlation and provenance for this direct Run. */
  readonly links?: DirectRunLinks;
}

type OrchestratorLifecycle =
  | "created"
  | "setup"
  | "starting"
  | "started"
  | "stopped";

export class Orchestrator {
  readonly registry: Registry;
  readonly config: Config;
  readonly store: OrchestratorStore;
  readonly #logger: OrchestratorLogger;
  readonly #queueExtensions: Extensions;
  readonly #journal: RunObservationJournal;
  readonly #jobs: JobLifecycle;
  readonly #suspensions: SuspensionLifecycle;
  readonly #persistence: ExecutionPersistence | undefined;
  readonly #participants: ExecutionParticipants;

  // Initialized by setup(); accessed via #requireQueue.
  #queue: Queue | null = null;
  #lifecycle: OrchestratorLifecycle = "created";
  #setupPromise: Promise<void> | null = null;
  #startPromise: Promise<readonly string[]> | null = null;
  #stopPromise: Promise<void> | null = null;
  #recoveredRunIds: readonly string[] = [];
  readonly #frameTails = new Map<string, Promise<void>>();
  readonly #queueObservationUnsubscribes: Unsubscribe[] = [];
  // Long-lived scope for recovered runs. Keeps Workflow.create's subscribers
  // mirrors alive past the construction Effect.
  readonly #scope: Scope.CloseableScope;

  constructor(opts: OrchestratorOptions) {
    contributeQueueConfig(opts.config);
    this.registry = opts.registry ?? new Registry();
    this.config = opts.config;
    this.#persistence = opts.persistence;
    if (opts.persistence && opts.store) {
      throw new Error("Provide either persistence or store, not both");
    }
    this.store = opts.persistence
      ? orchestratorStoreFromPersistence(opts.persistence)
      : (opts.store ?? new InMemoryOrchestratorStore());
    this.#participants = new ExecutionParticipants(
      opts.persistence,
      this.store,
      opts.admissionParticipant,
      opts.cancellationParticipant
    );
    this.#logger = opts.logger ?? new BaseOrchestratorLogger();
    this.#queueExtensions = createExtensions(opts.queueExtensions);
    this.#journal = new RunObservationJournal(this.store);
    this.#jobs = new JobLifecycle({
      executeJob: (job) => this.#executeJob(job),
      store: this.store,
    });
    this.#suspensions = new SuspensionLifecycle({
      publish: (record) => {
        const publication = this.#enqueueRunFrame(record.runId, {
          kind: "suspension",
          value: record,
        });
        this.#watchPublication(record.runId, publication);
        return publication;
      },
      resume: async (record, resolution) => {
        const dispatched = await this.#requireStartedQueue().get(record.runId);
        if (!dispatched) {
          throw new RunNotFoundError(record.runId);
        }
        await dispatched.resumeOccurrence(
          record.stepPath,
          record.name,
          record.occurrence,
          resolution
        );
      },
      store: this.store,
      withRunControl: (runId, operation) =>
        this.#requireStartedQueue().withRunControl(runId, operation),
    });
    this.#scope = Effect.runSync(Scope.make());
  }

  /**
   * Throws if setup() has not been called yet. Centralizes the invariant.
   */
  #requireQueue(): Queue {
    if (this.#queue === null) {
      throw new Error(
        "[foundry/workflows] Orchestrator.setup() must be called before this method"
      );
    }
    return this.#queue;
  }

  #requireStartedQueue(): Queue {
    if (this.#lifecycle === "stopped") {
      throw new Error("Orchestrator is shut down");
    }
    if (this.#lifecycle !== "started") {
      throw new OrchestratorNotStartedError();
    }
    return this.#requireQueue();
  }

  register<I, O, X extends BaseContext = BaseContext>(
    name: string,
    factory: Factory<I, O, X>
  ): void {
    this.registry.register(name, factory);
  }

  resolve<I = unknown, O = unknown, X extends BaseContext = BaseContext>(
    name: string
  ): Factory<I, O, X>;
  resolve(
    suspensionId: string,
    resolution: JsonValue,
    options?: ResolveSuspensionOptions
  ): Promise<SuspensionRecord>;
  resolve<I = unknown, O = unknown, X extends BaseContext = BaseContext>(
    nameOrSuspensionId: string,
    resolution?: JsonValue,
    options?: ResolveSuspensionOptions
  ): Factory<I, O, X> | Promise<SuspensionRecord> {
    if (arguments.length === 1) {
      return this.registry.resolve<I, O, X>(nameOrSuspensionId);
    }
    return this.#suspensions.resolve(
      nameOrSuspensionId,
      resolution as JsonValue,
      options
    );
  }

  resolveDefinition<
    I = unknown,
    O = unknown,
    X extends BaseContext = BaseContext,
  >(name: string): Factory<I, O, X> {
    return this.registry.resolve<I, O, X>(name);
  }

  registered(): readonly string[] {
    return this.registry.names();
  }

  /**
   * @internal Effect-typed implementation. Resolves the factory, builds
   * the instance under the caller's Scope, auto-wraps Step → Workflow,
   * dispatches on queue, threading `name` into `runs.step` for recovery.
   */
  #run<I, O>(
    name: string,
    input: I,
    options?: RunOptions
  ): Effect.Effect<DispatchedWorkflow<I, O>, never, Scope.Scope> {
    // Resolution erases the registered context type back to `BaseContext`
    // (the registry namespace is context-agnostic — see `Registry.resolve`).
    // The executor doesn't need the typed bag, so everything downstream
    // runs as `BaseContext` and no further cast is required here.
    const queue = this.#requireStartedQueue();
    const factory = this.registry.resolve<I, O>(name);
    const runId = generateId("rn");
    const definition = Object.freeze({ name });
    const links = Object.freeze({ ...(options?.links ?? {}) });
    const persistedLinks = Object.keys(links).length === 0 ? undefined : links;
    const context: RunExecutionContext = Object.freeze({
      claimEffect: (key: string, metadata?: JsonValue) =>
        this.#enqueueRunClaim(runId, key, metadata),
      definition,
      emitOutput: (value: JsonValue) =>
        this.#enqueueRunFrame(runId, { kind: "output", value }),
      links,
      runId,
    });
    return Effect.gen(this, function* () {
      const instance = yield* factoryToEffect(factory, input, context);
      const workflow = yield* Orchestrator.#asWorkflow(instance, input);
      this.#wireWorkflowObservation(workflow, runId);
      const dispatched = queue.dispatch(workflow, {
        step: name,
        ...(options?.extensions === undefined
          ? {}
          : { extensions: options.extensions }),
        definition,
        runId,
        ...(persistedLinks === undefined ? {} : { links: persistedLinks }),
      } satisfies DispatchOptions);
      yield* Effect.promise(() => queue.awaitPersistence(dispatched.id));
      return dispatched;
    });
  }

  /**
   * Run a registered runnable by name. Promises-based wrapper around
   * {@link #run}, threaded through the orchestrator-owned scope so
   * forked subscribers outlive this call.
   */
  run<I, O>(
    name: string,
    input: I,
    options?: RunOptions
  ): Promise<DispatchedWorkflow<I, O>> {
    return Effect.runPromise(
      this.#run<I, O>(name, input, options).pipe(Scope.extend(this.#scope))
    );
  }

  createJob(
    definition: string,
    input: JsonValue,
    options?: CreateJobOptions
  ): Promise<JobRecord> {
    return this.#jobs.create(definition, input, options);
  }

  execute(jobId: string): Promise<DispatchedWorkflow<JsonValue>> {
    this.#requireStartedQueue();
    return this.#jobs.execute(jobId);
  }

  getJob(jobId: string): Promise<JobRecord | null> {
    return this.#jobs.get(jobId);
  }

  listJobs(query?: JobQuery): Promise<Page<JobRecord>> {
    return this.#jobs.list(query);
  }

  /** Durable Run lookup for host-facing execution facades. */
  getRun(runId: string): Promise<RunRecord | null> {
    return this.store.getRun(runId);
  }

  /** Durable Run listing for host-facing execution facades. */
  listRuns(query: RunQuery = {}): Promise<RunPage> {
    return this.store.listRuns(query);
  }

  /** Compatibility-safe projection; never exposes Queue mutation or storage. */
  async listQueueDiagnostics(): Promise<readonly QueueDiagnostic[]> {
    const queues = await this.store.listQueues();
    return Object.freeze(
      queues.map((queue) =>
        Object.freeze({
          createdAt: queue.createdAt,
          id: queue.id,
          lastError:
            queue.lastError === null
              ? null
              : Object.freeze({ ...queue.lastError }),
          name: queue.name,
          status: queue.status,
        })
      )
    );
  }

  async cancelRun(runId: string): Promise<RunRecord> {
    const queue = this.#requireStartedQueue();
    const settled = await this.#participants.cancel(runId);
    if (settled) {
      if (settled.status === "cancelled") {
        const afterCommit = this.#persistence?.afterCommit;
        if (afterCommit) {
          await afterCommit(() =>
            queue
              .applyAuthoritativeCancellation(runId)
              .catch((error: unknown) => {
                console.error("Run cancellation projection failed:", error);
              })
          );
        } else {
          await queue.applyAuthoritativeCancellation(runId);
        }
      }
      return settled;
    }
    const cancellation = await this.#suspensions.requestRunCancellation(runId);
    await queue.applyAuthoritativeCancellation(runId);
    return cancellation.run;
  }

  coordinateSettlement<T>(
    runId: string,
    operation: (run: RunRecord, persistence: ExecutionPersistence) => Promise<T>
  ): Promise<T> {
    return this.#participants.settle(runId, operation);
  }

  async cancelJob(jobId: string): Promise<JobRecord> {
    const queue = this.#requireStartedQueue();
    const cancellation = await this.#jobs.cancel(jobId);
    await this.#suspensions.publishCancelled(cancellation.suspensions);
    if (cancellation.run) {
      await queue.applyAuthoritativeCancellation(cancellation.run.id);
    }
    return cancellation.job;
  }

  async #executeJob(job: JobRecord): Promise<DispatchedWorkflow<JsonValue>> {
    const queue = this.#requireStartedQueue();
    const definition = job.definition;
    const factory = this.registry.resolve<JsonValue>(definition.name);
    const runId = generateId("rn");
    const inheritedLinks = jobLinksToRunLinks(job.links);
    const links: RunLinks = Object.freeze({
      ...inheritedLinks,
      jobId: job.id,
    });
    const construction = this.#runContext(runId, definition, links);

    const prepared = await Effect.runPromise(
      Effect.gen(this, function* () {
        const instance = yield* factoryToEffect(
          factory,
          job.input,
          construction.context
        );
        const workflow = yield* Orchestrator.#asWorkflow(instance, job.input);
        this.#wireWorkflowObservation(workflow, runId);
        const state = workflow.state;
        return { state, workflow };
      }).pipe(Scope.extend(this.#scope))
    );
    construction.finish();
    const claimInput = {
      id: runId,
      input: prepared.state.input,
      queueId: queue.id,
      step: definition.name,
      ...(prepared.state.tree === null
        ? {}
        : { snapshot: prepared.state.tree }),
      definition,
      links: inheritedLinks,
      metadata: {
        workflow: {
          input: prepared.state.input,
          steps: prepared.state.steps,
          tree: prepared.state.tree,
        },
      },
    };
    const claim = await this.#participants.claim(job.id, claimInput);
    // Admission was preflighted before the atomic claim. If a shutdown race
    // still rejects here, retain the queued row for normal cold recovery.
    return queue.dispatchPersisted(
      prepared.workflow,
      {
        definition: claim.run.definition,
        extensions: claim.run.extensions,
        id: claim.run.id,
        input: claim.run.input,
        lastStatus: claim.run.status,
        links: claim.run.links,
        metadata: claim.run.metadata,
        step: claim.run.step,
      },
      this.#persistence?.afterCommit
    );
  }

  /**
   * Resolve the default queue row by name (getOrCreate semantics) and
   * construct the running Queue. Concurrent and repeated calls share one
   * setup attempt and one Queue instance.
   */
  setup(): Promise<void> {
    if (this.#lifecycle === "stopped") {
      return Promise.reject(new Error("Orchestrator is shut down"));
    }
    if (this.#setupPromise) {
      return this.#setupPromise;
    }

    const attempt: Promise<void> = (async () => {
      const name = this.config.get("queue.defaultName");
      const concurrency = this.config.get("queue.concurrency");
      const existing = await this.store.listQueues();
      const initial =
        existing.find((q) => q.name === name) ??
        (await this.store.ensureQueue({
          extensions: this.#queueExtensions,
          id: generateId("qu"),
          name,
        }));
      const row =
        Object.keys(this.#queueExtensions).length === 0
          ? initial
          : ((await this.store.updateQueue(initial.id, {
              extensions: this.#queueExtensions,
            })) ?? initial);
      const queue = new Queue({
        concurrency,
        extensions: row.extensions,
        id: row.id,
        logger: this.#logger,
        onRunCancelled: (runId, runPatch) =>
          this.#suspensions.cancelRun(runId, runPatch),
        onRunSuspended: (runId, step, suspension, runPatch) =>
          this.#suspensions
            .park(runId, step, suspension, runPatch)
            .then(() => undefined),
        store: this.store,
      });
      this.#attachQueueObservation(queue);
      this.#queue = queue;
      if (this.#lifecycle === "stopped") {
        await queue.shutdown();
        return;
      }
      this.#lifecycle = "setup";
    })().catch((error: unknown) => {
      if (this.#setupPromise === attempt) {
        this.#setupPromise = null;
      }
      if (this.#lifecycle !== "stopped") {
        this.#lifecycle = "created";
      }
      throw error;
    });
    this.#setupPromise = attempt;
    return attempt;
  }

  /**
   * Recover durable non-terminal Runs exactly once, then begin accepting work.
   * A failed recovery leaves the Orchestrator setup but non-serving so callers
   * may register the missing definition and retry start().
   */
  async start(): Promise<void> {
    await this.#startLifecycle();
  }

  /**
   * Graceful stop: pause, drain in-flight runs, interrupt the driver, and
   * close the orchestrator-owned scope. No-op if setup() was never called.
   */
  stop(opts?: { graceMs?: number }): Promise<void> {
    if (this.#stopPromise) {
      return this.#stopPromise;
    }
    this.#lifecycle = "stopped";
    this.#stopPromise = (async () => {
      if (this.#queue !== null) {
        await this.#queue.shutdown(opts);
      }
      for (const unsubscribe of this.#queueObservationUnsubscribes.splice(0)) {
        unsubscribe();
      }
      await Effect.runPromise(Scope.close(this.#scope, Exit.void));
    })();
    return this.#stopPromise;
  }

  /**
   * Compatibility alias for the pre-live startup gate. Before startup this
   * performs the same recovery-and-start transition as start(); once live it
   * rejects so recovery cannot be re-entered independently.
   */
  async recover(): Promise<readonly string[]> {
    if (this.#lifecycle === "started") {
      throw new Error(
        "Recovery is owned by Orchestrator.start() and cannot run after startup"
      );
    }
    return this.#startLifecycle();
  }

  async #startLifecycle(): Promise<readonly string[]> {
    if (this.#lifecycle === "stopped") {
      throw new Error("Orchestrator is shut down");
    }
    if (this.#lifecycle === "started") {
      return this.#recoveredRunIds;
    }
    const queue = this.#requireQueue();
    if (this.#startPromise) {
      return this.#startPromise;
    }

    this.#lifecycle = "starting";
    const attempt = this.#recoverColdStart(queue)
      .then((recoveredRunIds) => {
        if (this.#lifecycle === "stopped") {
          throw new Error("Orchestrator is shut down");
        }
        this.#recoveredRunIds = recoveredRunIds;
        this.#lifecycle = "started";
        return recoveredRunIds;
      })
      .catch((error: unknown) => {
        if (this.#lifecycle !== "stopped") {
          this.#lifecycle = "setup";
        }
        this.#startPromise = null;
        throw error;
      });
    this.#startPromise = attempt;
    return attempt;
  }

  async #recoverColdStart(queue: Queue): Promise<readonly string[]> {
    const rows = await queue.findRecoverableRuns();
    this.#throwIfStopped();
    for (const row of rows) {
      const definition = row.definition?.name ?? row.step;
      if (!this.registry.has(definition)) {
        throw new RecoverableDefinitionMissingError(row.id, definition);
      }
    }

    const prepared: {
      readonly row: (typeof rows)[number];
      readonly workflow: Workflow;
    }[] = [];
    for (const row of rows) {
      const definition = row.definition ?? { name: row.step };
      const factory = this.registry.resolve(definition.name);
      const construction = this.#runContext(
        row.id,
        definition,
        row.links ?? {}
      );
      let suspensionRecords = await collectPageItems((page) =>
        this.#suspensions.list({ runId: row.id, ...page })
      );
      if (row.lastStatus === "suspended" && row.suspension) {
        await this.#suspensions.park(row.id, row.step, row.suspension);
        suspensionRecords = await collectPageItems((page) =>
          this.#suspensions.list({ runId: row.id, ...page })
        );
      } else if (
        row.lastStatus === "suspended" &&
        !suspensionRecords.some((record) => record.status === "pending")
      ) {
        throw new Error(`Suspended Run ${row.id} has no suspension authority`);
      }
      const workflow = await Effect.runPromise(
        Effect.gen(this, function* () {
          const instance = yield* factoryToEffect(
            factory,
            row.input,
            construction.context
          );
          const workflow = yield* Orchestrator.#asWorkflow(instance, row.input);
          const seedSteps = Orchestrator.#snapshotStepsFromMetadata(
            row.metadata
          );
          if (seedSteps !== null) {
            yield* workflow.root.snapshot.seed(seedSteps);
          }
          for (const suspension of suspensionRecords) {
            if (suspension.status === "resolved") {
              yield* Effect.promise(() =>
                workflow.resolveOccurrence(
                  suspension.stepPath,
                  suspension.name,
                  suspension.occurrence,
                  suspension.resolution
                )
              );
            }
          }
          this.#wireWorkflowObservation(workflow, row.id);
          return workflow;
        }).pipe(Scope.extend(this.#scope))
      );
      construction.finish();
      this.#throwIfStopped();
      await this.#participants.recover(row.id, row.links?.jobId);
      prepared.push({ row, workflow });
    }
    this.#throwIfStopped();
    return prepared.map(({ row, workflow }) => {
      const adopt = () => {
        queue.adopt(workflow, row);
      };
      if (this.#persistence?.afterCommit) {
        this.#persistence.afterCommit(adopt);
      } else {
        adopt();
      }
      return row.id;
    });
  }

  #throwIfStopped(): void {
    if (this.#lifecycle === "stopped") {
      throw new Error("Orchestrator is shut down");
    }
  }

  pause(): Promise<void> {
    return this.#requireQueue().pause();
  }
  resume(): Promise<void> {
    return this.#requireQueue().resume();
  }
  drain(opts?: { graceMs?: number }): Promise<void> {
    return this.#requireQueue().drain(opts);
  }
  get(runId: string): Promise<DispatchedWorkflow | null> {
    return this.#requireQueue().get(runId);
  }

  getSuspension(id: string): Promise<SuspensionRecord | null> {
    return this.#suspensions.get(id);
  }

  listSuspensions(query?: SuspensionQuery): Promise<Page<SuspensionRecord>> {
    return this.#suspensions.list(query);
  }

  async observe(
    runId: string,
    options?: ObserveRunOptions
  ): Promise<RunObservation> {
    await this.#frameTails.get(runId)?.catch(() => undefined);
    return this.#journal.observe(runId, options);
  }

  /**
   * Delete every queued (not-yet-started) run row from the orchestrator's
   * queue. Mirrors the library's `clearQueue` semantics — only rows in
   * status `queued` are dropped; running/suspended/terminal rows are left
   * untouched. Idempotent: a second call on an empty queue is a no-op.
   */
  async clearQueue(): Promise<void> {
    const queue = this.#requireQueue();
    for (;;) {
      const queued = await this.store.listRuns({
        limit: 50,
        queueId: queue.id,
        status: "queued",
      });
      for (const row of queued.items) {
        await this.#frameTails.get(row.id)?.catch(() => undefined);
        await this.#journal.deleteRun(row.id);
      }
      if (!queued.hasMore) {
        break;
      }
    }
  }

  /**
   * Subscribe to queue-wide events. Returns an unsubscribe handle.
   */
  on(
    event: QueueEvent,
    handler: (payload: QueueEventPayload) => void
  ): Unsubscribe {
    return this.#requireQueue().on(event, handler);
  }

  #attachQueueObservation(queue: Queue): void {
    const events: readonly QueueEvent[] = [
      "dispatched",
      "started",
      "suspended",
      "resumed",
      "complete",
      "failed",
      "cancelled",
    ];
    for (const event of events) {
      this.#queueObservationUnsubscribes.push(
        queue.on(event, (payload) => {
          const at = Date.parse(payload.at);
          const publication = this.#enqueueRunFrame(
            payload.runId,
            {
              kind: "lifecycle",
              value: {
                at: payload.at,
                event,
                status: payload.status,
                step: payload.step,
              },
            },
            () => queue.awaitPersistence(payload.runId),
            Number.isFinite(at) ? at : undefined
          );
          this.#watchPublication(payload.runId, publication);
        })
      );
    }
  }

  #wireWorkflowObservation<I, O, X extends BaseContext>(
    workflow: Workflow<I, O, X>,
    runId: string
  ): void {
    workflow.setObservationCallbacks({
      onLog: (entry) => {
        this.#watchPublication(
          runId,
          this.#enqueueRunFrame(runId, {
            kind: "log",
            value: logEntryToJsonValue(entry),
          })
        );
      },
      onProgress: (value) => {
        this.#watchPublication(
          runId,
          this.#enqueueRunFrame(runId, { kind: "progress", value })
        );
      },
    });
  }

  #watchPublication(runId: string, publication: Promise<void>): void {
    void publication.catch((error: unknown) =>
      this.#journal.fail(runId, error)
    );
  }

  #runContext(runId: string, definition: DefinitionReference, links: RunLinks) {
    let constructing = true;
    const context: RunExecutionContext = Object.freeze({
      claimEffect: (key: string, metadata?: JsonValue) => {
        if (constructing) {
          throw new Error(
            "Factory construction cannot claim execution effects"
          );
        }
        return this.#enqueueRunClaim(runId, key, metadata);
      },
      definition,
      emitOutput: (value: JsonValue) => {
        if (constructing) {
          throw new Error("Factory construction cannot emit execution output");
        }
        return this.#enqueueRunFrame(runId, { kind: "output", value });
      },
      links,
      runId,
    });
    return {
      context,
      finish: () => {
        constructing = false;
      },
    };
  }

  #enqueueRunFrame(
    runId: string,
    payload: RunFramePayload,
    before?: () => Promise<void>,
    at?: number
  ): Promise<void> {
    return this.#enqueueFrameOperation(runId, async () => {
      if (before) {
        await before();
      }
      await this.#journal.publish(runId, payload, at);
    });
  }

  #enqueueRunClaim(
    runId: string,
    key: string,
    metadata?: JsonValue
  ): Promise<boolean> {
    return this.#enqueueFrameOperation(runId, () =>
      this.#journal.claimEffect(runId, key, metadata)
    );
  }

  #enqueueFrameOperation<T>(
    runId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.#frameTails.get(runId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined);
    this.#frameTails.set(runId, tail);
    void tail
      .finally(() => {
        if (this.#frameTails.get(runId) === tail) {
          this.#frameTails.delete(runId);
        }
      })
      .catch(() => undefined);
    return result;
  }

  /**
   * Auto-wrap a Step into a one-shot Workflow. Built via
   * {@link Workflow.attach} so all paths in the Step's tree
   * participate in skip-on-complete.
   */
  static #asWorkflow<I, O, X extends BaseContext = BaseContext>(
    instance: Runnable<I, O, X>,
    input: I
  ): Effect.Effect<Workflow<I, O, X>, never, Scope.Scope> {
    if (instance.kind === "workflow") {
      return Effect.succeed(instance);
    }
    return Effect.sync(() => Workflow.attach<I, O, X>(instance, input));
  }

  /**
   * Translate the persisted `runs.metadata.workflow.steps` blob into
   * the `Record<string, StepSnapshot>` shape `Snapshot.seed` accepts.
   * Returns null when the blob is absent or malformed — recovery then
   * runs the workflow from the top.
   */
  static #snapshotStepsFromMetadata(
    metadata: Record<string, unknown> | undefined
  ): Record<string, StepSnapshot> | null {
    const wf = metadata?.workflow;
    if (!wf || typeof wf !== "object") {
      return null;
    }
    const steps = (wf as { steps?: unknown }).steps;
    return Option.getOrNull(decodeSeedSteps(steps));
  }
}

export type { CreateJobOptions } from "./job-lifecycle";
export type { QueueEvent, QueueEventPayload } from "./queue-types";
export type { ObserveRunOptions, RunObservation } from "./run-observation";
export type { ResolveSuspensionOptions } from "./suspension-lifecycle";

function logEntryToJsonValue(entry: TelemetryLogEntry): JsonValue {
  if (Schema.is(JsonValueSchema)(entry)) {
    return entry;
  }
  return {
    at: entry.at,
    level: entry.level,
    message: entry.message,
    ...(entry.stepId === undefined ? {} : { stepId: entry.stepId }),
    ...(entry.path === undefined ? {} : { path: [...entry.path] }),
  };
}

function jobLinksToRunLinks(links: JobLinks): Omit<RunLinks, "jobId"> {
  return {
    ...(links.sessionId === undefined ? {} : { sessionId: links.sessionId }),
    ...(links.invocationId === undefined
      ? {}
      : { invocationId: links.invocationId }),
    ...(links.subjectId === undefined ? {} : { subjectId: links.subjectId }),
    ...(links.principalId === undefined
      ? {}
      : { principalId: links.principalId }),
  };
}
