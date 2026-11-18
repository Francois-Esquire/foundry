import type { Page } from "@foundry/core/pagination";
import type { Config } from "@foundry/lib/config";
import { Effect, Exit, Scope } from "effect";
import { contributeQueueConfig } from "./config";
import type { DispatchedWorkflow } from "./dispatched-workflow";
import {
  DefinitionNotRegisteredError,
  OrchestratorNotStartedError,
  RecordAlreadyExistsError,
  RecoverableDefinitionMissingError,
  RunNotFoundError,
} from "./errors";
import type { BaseContext } from "./executable";
import type {
  DirectRunLinks,
  JobQuery,
  RecoverableRun,
  RunQuery,
  SuspensionQuery,
} from "./execution-commands";
import type { OrchestratorStore } from "./execution-coordinator";
import {
  ExecutionCoordinator,
  requireDurableStore,
} from "./execution-coordinator";
import { ExecutionParticipants } from "./execution-participants";
import type { Extensions } from "./extensions";
import { createExtensions } from "./extensions";
import { runEffectPromise } from "./helpers";
import type { CreateJobOptions } from "./job-lifecycle";
import { JobLifecycle } from "./job-lifecycle";
import type { JsonValue } from "./json-value";
import { isJsonValue } from "./json-value";
import type { OrchestratorLogger } from "./logger";
import { BaseOrchestratorLogger } from "./logger";
import { Queue } from "./queue";
import type {
  DispatchOptions,
  QueueEvent,
  QueueEventPayload,
} from "./queue-types";
import { recordOf } from "./record-fields";
import type { ObserveRunOptions, RunObservation } from "./run-observation";
import { RunObservationJournal } from "./run-observation";
import type {
  DefinitionReference,
  JobLinks,
  JobRecord,
  QueueRecord,
  RunFramePayload,
  RunLinks,
  RunRecord,
  SuspensionRecord,
} from "./schema";
import { StepSnapshotSchema } from "./schema";
import type { StepSnapshot } from "./snapshot";
import type { Step } from "./step";
import type { ResolveSuspensionOptions } from "./suspension-lifecycle";
import { SuspensionLifecycle } from "./suspension-lifecycle";
import type { TelemetryLogEntry } from "./telemetry";
import type { Unsubscribe } from "./types";
import { Workflow } from "./workflow";

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function collectPageItems<T>(
  list: (page: { limit: number; cursor: number }) => Promise<Page<T, number>>
): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await list({ cursor: offset, limit: 200 });
    items.push(...page.items);
    if (page.nextCursor === undefined) {
      return items;
    }
    offset = page.nextCursor;
  }
}

export type Runnable<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> = Step<I, O, X> | Workflow<I, O, X>;

export type { DirectRunLinks } from "./execution-commands";

export interface RunExecutionContext {
  readonly claimEffect: (key: string, metadata?: JsonValue) => Promise<boolean>;
  readonly definition: DefinitionReference;
  readonly emitOutput: (value: JsonValue) => Promise<void>;
  readonly links: RunLinks;
  readonly runId: string;
}

export interface QueueDiagnostic {
  readonly createdAt: number;
  readonly id: string;
  readonly lastError: QueueRecord["lastError"];
  readonly name: string;
  readonly status: QueueRecord["status"];
}

export type Factory<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> = (
  input: I,
  context?: RunExecutionContext
) => Runnable<I, O, X> | Promise<Runnable<I, O, X>>;

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

const SeedStepsSchema = recordOf(StepSnapshotSchema);

export class Registry {
  readonly #factories = new Map<string, Factory>();

  register<I, O, X extends BaseContext = BaseContext>(
    name: string,
    factory: Factory<I, O, X>
  ): void {
    if (this.#factories.has(name)) {
      throw new Error(`already registered: "${name}"`);
    }
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
    readonly store: OrchestratorStore;
  }) => Promise<JsonValue>;
  readonly cancellationParticipant?: (input: {
    readonly run: RunRecord;
    readonly store: OrchestratorStore;
  }) => Promise<RunRecord | null>;
  readonly config: Config;
  readonly logger?: OrchestratorLogger;
  readonly queueExtensions?: Extensions;
  readonly recovers?: (run: RecoverableRun) => boolean;
  readonly registry?: Registry;
  readonly store?: OrchestratorStore;
}

export interface RunOptions {
  readonly extensions?: Extensions;
  readonly links?: DirectRunLinks;
  readonly runId?: string;
  readonly signal?: AbortSignal;
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
  readonly #participants: ExecutionParticipants;
  readonly #recovers: (run: RecoverableRun) => boolean;

  #queue: Queue | null = null;
  #lifecycle: OrchestratorLifecycle = "created";
  #setupPromise: Promise<void> | null = null;
  #startPromise: Promise<readonly string[]> | null = null;
  #stopPromise: Promise<void> | null = null;
  #recoveredRunIds: readonly string[] = [];
  readonly #frameTails = new Map<string, Promise<void>>();
  readonly #reserving = new Set<string>();
  readonly #queueObservationUnsubscribes: Unsubscribe[] = [];
  readonly #scope: Scope.CloseableScope;

  constructor(opts: OrchestratorOptions) {
    contributeQueueConfig(opts.config);
    this.registry = opts.registry ?? new Registry();
    this.config = opts.config;
    this.store = opts.store ?? new ExecutionCoordinator();
    requireDurableStore(this.store, "Orchestrator");
    this.#participants = new ExecutionParticipants(
      this.store,
      opts.admissionParticipant,
      opts.cancellationParticipant
    );
    this.#recovers = opts.recovers ?? (() => true);
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
    ...resolutionAndOptions:
      | []
      | [resolution: JsonValue, options?: ResolveSuspensionOptions]
  ): Factory<I, O, X> | Promise<SuspensionRecord> {
    if (resolutionAndOptions.length === 0) {
      return this.registry.resolve<I, O, X>(nameOrSuspensionId);
    }
    const [resolution, options] = resolutionAndOptions;
    return this.#suspensions.resolve(nameOrSuspensionId, resolution, options);
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
    const queue = this.#requireStartedQueue();
    const factory = this.registry.resolve<I, O>(name);
    const runId = options?.runId ?? generateId("rn");
    const definition = Object.freeze({ name });
    const links = Object.freeze({ ...(options?.links ?? {}) });
    const persistedLinks = Object.keys(links).length === 0 ? undefined : links;
    const construction = this.#runContext(runId, definition, links, () =>
      queue.awaitPersistence(runId)
    );
    let reserved = false;
    return Effect.gen(this, function* () {
      yield* Orchestrator.#unlessWithdrawn(runId, options?.signal);
      if (options?.runId !== undefined) {
        yield* this.#reserve(queue, runId);
        reserved = true;
      }
      const instance = yield* factoryToEffect(
        factory,
        input,
        construction.context
      );
      const workflow = yield* Orchestrator.#asWorkflow(instance, input);
      yield* Orchestrator.#unlessWithdrawn(runId, options?.signal);
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
      construction.finish();
      yield* Effect.promise(() => queue.awaitPersistence(dispatched.id));
      return dispatched;
    }).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (reserved) {
            this.#reserving.delete(runId);
          }
          if (Exit.isFailure(exit)) {
            construction.refuse();
          }
        })
      )
    );
  }

  #reserve(queue: Queue, runId: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.#reserving.has(runId)) {
        return Effect.die(new RecordAlreadyExistsError("run", runId));
      }
      this.#reserving.add(runId);
      return Effect.promise(
        async () =>
          (await queue.get(runId)) !== null ||
          (await this.store.getRun(runId)) !== null
      ).pipe(
        Effect.flatMap((taken) => {
          if (!taken) {
            return Effect.void;
          }
          return Effect.die(new RecordAlreadyExistsError("run", runId));
        }),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit)) {
              this.#reserving.delete(runId);
            }
          })
        )
      );
    });
  }

  run<I, O>(
    name: string,
    input: I,
    options?: RunOptions
  ): Promise<DispatchedWorkflow<I, O>> {
    if (options?.runId !== undefined && !options.runId.startsWith("rn-")) {
      return Promise.reject(
        new Error(`A Run id starts with "rn-": ${options.runId}`)
      );
    }
    return runEffectPromise(
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

  listJobs(query?: JobQuery): Promise<Page<JobRecord, number>> {
    return this.#jobs.list(query);
  }

  getRun(runId: string): Promise<RunRecord | null> {
    return this.store.getRun(runId);
  }

  listRuns(query: RunQuery = {}): Promise<Page<RunRecord, number>> {
    return this.store.listRuns(query);
  }

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
        await queue.applyAuthoritativeCancellation(runId);
      }
      return settled;
    }
    const cancellation = await this.#suspensions.requestRunCancellation(runId);
    await queue.applyAuthoritativeCancellation(runId);
    return cancellation.run;
  }

  coordinateSettlement<T>(
    runId: string,
    operation: (run: RunRecord, store: OrchestratorStore) => Promise<T>
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
    const { definition } = job;
    const factory = this.registry.resolve<JsonValue>(definition.name);
    const runId = generateId("rn");
    const inheritedLinks = jobLinksToRunLinks(job.links);
    const links: RunLinks = Object.freeze({
      ...inheritedLinks,
      jobId: job.id,
    });
    const construction = this.#runContext(runId, definition, links);

    const prepared = await runEffectPromise(
      Effect.gen(this, function* () {
        const instance = yield* factoryToEffect(
          factory,
          job.input,
          construction.context
        );
        const workflow = yield* Orchestrator.#asWorkflow(instance, job.input);
        this.#wireWorkflowObservation(workflow, runId);
        const { state } = workflow;
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
    return queue.dispatchPersisted(prepared.workflow, {
      definition: claim.run.definition,
      extensions: claim.run.extensions,
      id: claim.run.id,
      input: claim.run.input,
      lastStatus: claim.run.status,
      links: claim.run.links,
      metadata: claim.run.metadata,
      step: claim.run.step,
    });
  }

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
        onRunSuspended: async (runId, step, suspension, runPatch) => {
          await this.#suspensions.park(runId, step, suspension, runPatch);
        },
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

  async start(): Promise<void> {
    await this.#startLifecycle();
  }

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
    const rows = (await queue.findRecoverableRuns()).filter(this.#recovers);
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
      prepared.push({ row, workflow: await this.#rebuild(row) });
    }
    this.#throwIfStopped();
    return prepared.map(({ row, workflow }) => {
      queue.adopt(workflow, row);
      return row.id;
    });
  }

  async adopt(runId: string): Promise<DispatchedWorkflow | null> {
    if (this.#lifecycle !== "started") {
      throw new Error(
        "An Orchestrator takes on a Run after start only once it has started"
      );
    }
    const queue = this.#requireQueue();
    const row = (await queue.findRecoverableRuns()).find(
      (candidate) => candidate.id === runId
    );
    if (row === undefined || row.lastStatus !== "suspended") {
      if (row !== undefined) {
        throw new Error(
          `Run ${runId} is ${row.lastStatus}, not suspended; only a parked Run is taken on after start`
        );
      }
      return null;
    }
    const definition = row.definition?.name ?? row.step;
    if (!this.registry.has(definition)) {
      throw new RecoverableDefinitionMissingError(row.id, definition);
    }
    await this.store.claimSuspensions(runId);
    const workflow = await this.#rebuild(row);
    this.#throwIfStopped();
    return queue.adopt(workflow, row);
  }

  async forget(runId: string): Promise<boolean> {
    return await this.#requireQueue().forget(runId);
  }

  async #rebuild(row: RecoverableRun): Promise<Workflow> {
    const definition = row.definition ?? { name: row.step };
    const factory = this.registry.resolve(definition.name);
    const construction = this.#runContext(row.id, definition, row.links ?? {});
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
    const workflow = await runEffectPromise(
      Effect.gen(this, function* () {
        const instance = yield* factoryToEffect(
          factory,
          row.input,
          construction.context
        );
        const runWorkflow = yield* Orchestrator.#asWorkflow(
          instance,
          row.input
        );
        const seedSteps = Orchestrator.#snapshotStepsFromMetadata(row.metadata);
        if (seedSteps !== null) {
          yield* runWorkflow.root.snapshot.seed(seedSteps);
        }
        for (const suspension of suspensionRecords) {
          if (suspension.status === "resolved") {
            yield* Effect.promise(() =>
              runWorkflow.resolveOccurrence(
                suspension.stepPath,
                suspension.name,
                suspension.occurrence,
                suspension.resolution
              )
            );
          }
        }
        this.#wireWorkflowObservation(runWorkflow, row.id);
        return runWorkflow;
      }).pipe(Scope.extend(this.#scope))
    );
    construction.finish();
    this.#throwIfStopped();
    await this.#participants.recover(row.id, row.links?.jobId);
    return workflow;
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

  listSuspensions(
    query?: SuspensionQuery
  ): Promise<Page<SuspensionRecord, number>> {
    return this.#suspensions.list(query);
  }

  async observe(
    runId: string,
    options?: ObserveRunOptions
  ): Promise<RunObservation> {
    await this.#frameTails.get(runId)?.catch(() => undefined);
    return this.#journal.observe(runId, options);
  }

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
      if (queued.nextCursor === undefined) {
        break;
      }
    }
  }

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
    publication.catch((error: unknown) => this.#journal.fail(runId, error));
  }

  #runContext(
    runId: string,
    definition: DefinitionReference,
    links: RunLinks,
    persisted?: () => Promise<void>
  ) {
    let phase: "constructing" | "dispatched" | "refused" = "constructing";
    const usable = (refusal: string) => {
      if (phase === "constructing") {
        throw new Error(`Factory construction cannot ${refusal}`);
      }
      if (phase === "refused") {
        throw new Error(
          `Run ${runId} was not dispatched; it cannot ${refusal}`
        );
      }
    };
    const context: RunExecutionContext = Object.freeze({
      claimEffect: (key: string, metadata?: JsonValue) => {
        usable("claim execution effects");
        return this.#enqueueRunClaim(runId, key, metadata, persisted);
      },
      definition,
      emitOutput: (value: JsonValue) => {
        usable("emit execution output");
        return this.#enqueueRunFrame(
          runId,
          { kind: "output", value },
          persisted
        );
      },
      links,
      runId,
    });
    return {
      context,
      finish: () => {
        if (phase === "constructing") {
          phase = "dispatched";
        }
      },
      refuse: () => {
        phase = "refused";
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
    metadata?: JsonValue,
    before?: () => Promise<void>
  ): Promise<boolean> {
    return this.#enqueueFrameOperation(runId, async () => {
      if (before) {
        await before();
      }
      return await this.#journal.claimEffect(runId, key, metadata);
    });
  }

  #enqueueFrameOperation<T>(
    runId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.#frameTails.get(runId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined);
    this.#frameTails.set(runId, tail);
    tail
      .finally(() => {
        if (this.#frameTails.get(runId) === tail) {
          this.#frameTails.delete(runId);
        }
      })
      .catch(() => undefined);
    return result;
  }

  static #unlessWithdrawn(
    runId: string,
    signal: AbortSignal | undefined
  ): Effect.Effect<void> {
    return Effect.suspend(() =>
      signal?.aborted
        ? Effect.die(
            new Error(`Run ${runId} was cancelled before it was dispatched`, {
              cause: signal.reason,
            })
          )
        : Effect.void
    );
  }

  static #asWorkflow<I, O, X extends BaseContext = BaseContext>(
    instance: Runnable<I, O, X>,
    input: I
  ): Effect.Effect<Workflow<I, O, X>, never, Scope.Scope> {
    if (instance.kind === "workflow") {
      return Effect.succeed(instance);
    }
    return Effect.sync(() => Workflow.attach<I, O, X>(instance, input));
  }

  static #snapshotStepsFromMetadata(
    metadata: Record<string, unknown> | undefined
  ): Record<string, StepSnapshot> | null {
    const wf = metadata?.workflow;
    if (!wf || typeof wf !== "object") {
      return null;
    }
    const { steps } = wf as { steps?: unknown };
    const decoded = SeedStepsSchema.safeParse(steps);
    return decoded.success ? decoded.data : null;
  }
}

export type { CreateJobOptions } from "./job-lifecycle";
export type { QueueEvent, QueueEventPayload } from "./queue-types";
export type { ObserveRunOptions, RunObservation } from "./run-observation";
export type { ResolveSuspensionOptions } from "./suspension-lifecycle";

function logEntryToJsonValue(entry: TelemetryLogEntry): JsonValue {
  if (isJsonValue(entry)) {
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
