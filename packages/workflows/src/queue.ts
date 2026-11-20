import {
  Deferred,
  Effect,
  Queue as EffectQueue,
  Exit,
  Fiber,
  PubSub,
  Schedule,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";

import type { ChannelEvent } from "./channels";
import { DispatchedWorkflow } from "./dispatched-workflow";
import {
  RecordAlreadyExistsError,
  RunAlreadySettledError,
  RunNotFoundError,
} from "./errors";
import type { BaseContext } from "./executable";
import type { UpdateRunInput } from "./execution-commands";
import type { OrchestratorStore } from "./execution-coordinator";
import {
  ExecutionCoordinator,
  requireDurableStore,
} from "./execution-coordinator";
import { errorToShape } from "./helpers";
import { workflowEffectAccess } from "./internal/workflow-effect-access";
import type { OrchestratorLogger, RunLifecycleEvent } from "./logger";
import { BaseOrchestratorLogger } from "./logger";
import {
  decodeMetadataValue,
  encodePersistedMetadata,
  rowToRecoverable,
  stepsFromMetadata,
  streamFromMetadata,
  workflowStateFromMetadata,
} from "./metadata-codec";
import { defineOwnEntry } from "./own-entry";
import { QueueEvents } from "./queue-events";
import type {
  DispatchOptions,
  QueueEvent,
  QueueEventPayload,
  QueueOptions,
  QueueSize,
  RecoverableRun,
} from "./queue-types";
import type { PersistedWorkflow, RunLinks } from "./schema";
import type { TelemetryState } from "./telemetry";
import { Telemetry } from "./telemetry";
import type { QueueStatus, RunStatus, Unsubscribe } from "./types";
import type {
  ErrorShape,
  Workflow,
  WorkflowPersistence,
  WorkflowState,
} from "./workflow";

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function yieldToHost(): Effect.Effect<void> {
  return Effect.promise(
    () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  );
}

interface RunLane {
  eventBuffer: ChannelEvent[];
  insertPromise?: Promise<unknown>;
  writeMutex: Effect.Semaphore;
}

type RunFinishOutcome =
  | { readonly kind: "rejected" }
  | { readonly kind: "cancelled-before-start" }
  | { readonly kind: "parked" }
  | { readonly kind: "terminal" }
  | { readonly kind: "fatal" };

type RunStartOutcome = "started" | "cancelled-before-start";

export class Queue {
  readonly id: string;
  readonly #opts: QueueOptions;
  readonly #store: OrchestratorStore;
  readonly #logger: OrchestratorLogger;
  readonly #telemetry: Telemetry;

  readonly #semaphore: Effect.Semaphore;
  readonly #pendingQueue: EffectQueue.Queue<DispatchedWorkflow>;
  readonly #pausedRef: SubscriptionRef.SubscriptionRef<boolean>;
  readonly #outstandingRef: SubscriptionRef.SubscriptionRef<number>;

  readonly #all = new Map<string, DispatchedWorkflow>();
  readonly #events: QueueEvents;

  readonly #driverFiber: ReturnType<typeof Effect.runFork> | null;
  #shutdownPromise: Promise<void> | null = null;

  readonly #queueInsertPromise: Promise<unknown>;

  readonly #lanes = new Map<string, RunLane>();

  readonly #admissionFailures = new Map<string, Error>();
  readonly #controlTails = new Map<string, Promise<void>>();
  readonly #cancelledBeforeStart = new Set<string>();
  readonly #driverOwned = new Set<string>();
  readonly #outstandingOwned = new Set<string>();
  readonly #resumeReactors = new Map<string, Fiber.RuntimeFiber<void>>();
  #fatalError: Error | null = null;

  readonly #scope: Scope.CloseableScope;

  constructor(opts: QueueOptions) {
    this.#opts = opts;
    this.id = opts.id ?? generateId("qu");
    this.#store = opts.store ?? new ExecutionCoordinator();
    requireDurableStore(this.#store, "Queue");
    this.#queueInsertPromise = this.#store.ensureQueue({
      extensions: opts.extensions,
      id: this.id,
      name: this.id,
    });

    this.#scope = Effect.runSync(Scope.make());
    this.#telemetry = new Telemetry();
    this.#logger = opts.logger ?? new BaseOrchestratorLogger();
    this.#events = new QueueEvents({ id: this.id, telemetry: this.#telemetry });
    const setup = Effect.gen(function* () {
      const semaphore = yield* Effect.makeSemaphore(opts.concurrency);
      const pendingQueue = yield* EffectQueue.unbounded<DispatchedWorkflow>();
      const pausedRef = yield* SubscriptionRef.make(false);
      const outstandingRef = yield* SubscriptionRef.make(0);
      return { outstandingRef, pausedRef, pendingQueue, semaphore };
    });
    const init = Effect.runSync(setup);
    this.#semaphore = init.semaphore;
    this.#pendingQueue = init.pendingQueue;
    this.#pausedRef = init.pausedRef;
    this.#outstandingRef = init.outstandingRef;

    this.#driverFiber = Effect.runFork(this.#supervisedDriverLoop());
  }

  get options(): QueueOptions {
    return this.#opts;
  }

  get telemetry(): TelemetryState {
    return this.#telemetry.snapshot();
  }

  dispatch<I, O, X extends BaseContext>(
    workflow: Workflow<I, O, X>,
    opts?: DispatchOptions
  ): DispatchedWorkflow<I, O, X> {
    this.#assertServing("dispatch");
    if ((opts?.links as RunLinks | undefined)?.jobId !== undefined) {
      throw new Error(
        "Job-linked Runs must be created through Orchestrator.execute()"
      );
    }
    const id = opts?.runId ?? generateId("rn");
    if (this.#all.has(id)) {
      throw new RecordAlreadyExistsError("run", id);
    }
    const workflowState = workflow.state;

    const baseMetadata = {
      workflow: {
        input: workflowState.input,
        steps: workflowState.steps,
        tree: workflowState.tree,
      },
    };
    const stepName = opts?.step ?? workflow.name;
    this.#openLane(id, {
      insertPromise: this.#queueInsertPromise.then(() =>
        this.#store.createRun({
          id,
          input: workflowState.input,
          queueId: this.id,
          step: stepName,
          ...(workflowState.tree ? { snapshot: workflowState.tree } : {}),
          metadata: opts?.metadata
            ? { ...opts.metadata, ...baseMetadata }
            : baseMetadata,
          ...(opts?.extensions === undefined
            ? {}
            : { extensions: opts.extensions }),
          ...(opts?.definition === undefined
            ? {}
            : { definition: opts.definition }),
          ...(opts?.links === undefined ? {} : { links: opts.links }),
        })
      ),
    });

    const dispatched = new DispatchedWorkflow<I, O, X>({
      id,
      persist: (snap) =>
        Effect.runPromise(
          this.#persistSnapshot(id, stepName, snap, workflow.persistence)
        ),
      queueId: this.id,
      step: stepName,
      workflow,
      ...(this.#opts.onRunCancelled
        ? {
            onCancel: (snap: WorkflowState) =>
              this.#notifyRunCancelled(
                id,
                stepName,
                snap,
                workflow.persistence
              ),
          }
        : {}),
      authorityManagedSuspensions: this.#opts.onRunSuspended !== undefined,
      withControl: (operation) => this.withRunControl(id, operation),
    });
    this.#admit(dispatched as unknown as DispatchedWorkflow);
    return dispatched;
  }

  async awaitPersistence(runId: string): Promise<void> {
    const insertPromise = this.#lanes.get(runId)?.insertPromise;
    if (insertPromise) {
      await insertPromise;
      return;
    }
    const admissionFailure = this.#admissionFailures.get(runId);
    if (admissionFailure) {
      throw admissionFailure;
    }
  }

  #openLane(
    id: string,
    seed?: {
      insertPromise?: Promise<unknown>;
      eventBuffer?: ChannelEvent[];
    }
  ): RunLane {
    const existing = this.#lanes.get(id);
    if (existing) {
      return existing;
    }
    const lane: RunLane = {
      eventBuffer: seed?.eventBuffer ?? [],
      writeMutex: Effect.runSync(Effect.makeSemaphore(1)),
      ...(seed?.insertPromise ? { insertPromise: seed.insertPromise } : {}),
    };
    this.#lanes.set(id, lane);
    return lane;
  }

  #closeLane(id: string): void {
    this.#lanes.delete(id);
  }

  #acquireOutstanding(id: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.#outstandingOwned.has(id)) {
        return Effect.void;
      }
      this.#outstandingOwned.add(id);
      return SubscriptionRef.update(this.#outstandingRef, (count) => count + 1);
    });
  }

  #releaseOutstanding(id: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!this.#outstandingOwned.delete(id)) {
        return Effect.void;
      }
      return SubscriptionRef.update(this.#outstandingRef, (count) => count - 1);
    });
  }

  #admit(erased: DispatchedWorkflow, deferExecution = false): void {
    this.#all.set(erased.id, erased);
    this.#events.run("dispatched", erased);
    this.#emit({
      kind: "dispatched",
      runId: erased.id,
      step: erased.step,
      tags: {},
    });
    Effect.runSync(this.#acquireOutstanding(erased.id));
    const offer = EffectQueue.offer(this.#pendingQueue, erased);
    Effect.runPromise(
      deferExecution ? yieldToHost().pipe(Effect.zipRight(offer)) : offer
    ).catch(() => undefined);
  }

  get(runId: string): Promise<DispatchedWorkflow | null> {
    return Promise.resolve(this.#all.get(runId) ?? null);
  }

  /** @internal */
  async withRunControl<T>(
    runId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.#controlTails.get(runId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#controlTails.set(runId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#controlTails.get(runId) === tail) {
        this.#controlTails.delete(runId);
      }
    }
  }

  forget(runId: string): Promise<boolean> {
    return this.withRunControl(runId, async () => {
      const run = this.#all.get(runId);
      if (run === undefined) {
        return false;
      }
      if (
        run.status !== "suspended" ||
        this.#driverOwned.has(runId) ||
        this.#outstandingOwned.has(runId)
      ) {
        throw new Error(
          `Run ${runId} is ${run.status}, not parked; only a parked Run is forgotten`
        );
      }
      const reactor = this.#resumeReactors.get(runId);
      this.#resumeReactors.delete(runId);
      this.#all.delete(runId);
      this.#closeLane(runId);
      if (reactor !== undefined) {
        await Effect.runPromise(Fiber.interrupt(reactor));
      }
      return true;
    });
  }

  /** @internal */
  async applyAuthoritativeCancellation(runId: string): Promise<void> {
    const run = this.#all.get(runId);
    if (!run) {
      return;
    }
    await this.withRunControl(runId, async () => {
      const { status } = run;
      if (this.#driverOwned.has(runId)) {
        await run._cancelLiveAfterAuthorityUnlocked();
        return;
      }
      if (
        status === "complete" ||
        status === "failed" ||
        status === "cancelled"
      ) {
        return;
      }
      const result = await run._cancelLiveAfterAuthorityUnlocked();
      if (status === "suspended") {
        this.#events.run("cancelled", run);
        this.#emit({ kind: "cancelled", runId });
        this.#closeLane(runId);
        await Effect.runPromise(run._settle(result));
      } else {
        if (this.#outstandingOwned.has(runId)) {
          this.#cancelledBeforeStart.add(runId);
        }
        this.#events.run("cancelled", run);
        this.#emit({ kind: "cancelled", runId });
        this.#closeLane(runId);
        await Effect.runPromise(this.#releaseOutstanding(runId));
        await Effect.runPromise(run._settle(result));
      }
    });
  }

  async #readPersisted(
    runId: string
  ): Promise<{ status: RunStatus; workflow: PersistedWorkflow | null } | null> {
    try {
      const row = await this.#store.getRun(runId);
      if (!row) {
        return null;
      }
      return {
        status: row.status,
        workflow: decodeMetadataValue(row.metadata)?.workflow ?? null,
      };
    } catch {
      return null;
    }
  }

  async status(runId: string): Promise<RunStatus | null> {
    const cached = this.#all.get(runId);
    if (cached) {
      return cached.status;
    }
    return (await this.#readPersisted(runId))?.status ?? null;
  }

  async snapshot(runId: string): Promise<WorkflowState | null> {
    const cached = this.#all.get(runId);
    if (cached) {
      return cached.snapshot;
    }
    const persisted = await this.#readPersisted(runId);
    if (!persisted?.workflow) {
      return null;
    }
    return { ...persisted.workflow, status: persisted.status } as WorkflowState;
  }

  async results(
    runId: string
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const cached = this.#all.get(runId);
    if (cached) {
      return cached.results;
    }
    const persisted = await this.#readPersisted(runId);
    if (persisted === null) {
      return null;
    }
    const steps = persisted.workflow?.steps;
    if (!steps) {
      return {};
    }
    const out: Record<string, unknown> = {};
    for (const [key, step] of Object.entries(steps)) {
      if (step.status === "complete" && step.output !== undefined) {
        defineOwnEntry(out, key, step.output);
      }
    }
    return out;
  }

  async error(runId: string): Promise<ErrorShape | null> {
    const cached = this.#all.get(runId);
    if (cached) {
      return cached.error;
    }
    return (await this.#readPersisted(runId))?.workflow?.error ?? null;
  }

  adopt<I, O, X extends BaseContext>(
    workflow: Workflow<I, O, X>,
    recoverable: RecoverableRun
  ): DispatchedWorkflow<I, O, X> {
    this.#assertPersistedAdmissionAllowed(recoverable.id, "adopt");
    const dispatched = new DispatchedWorkflow<I, O, X>({
      id: recoverable.id,
      persist: (snap) =>
        Effect.runPromise(
          this.#persistSnapshot(
            recoverable.id,
            recoverable.step,
            snap,
            workflow.persistence
          )
        ),
      queueId: this.id,
      step: recoverable.step,
      workflow,
      ...(this.#opts.onRunCancelled
        ? {
            onCancel: (snap: WorkflowState) =>
              this.#notifyRunCancelled(
                recoverable.id,
                recoverable.step,
                snap,
                workflow.persistence
              ),
          }
        : {}),
      authorityManagedSuspensions: this.#opts.onRunSuspended !== undefined,
      withControl: (operation) =>
        this.withRunControl(recoverable.id, operation),
    });
    this.#openLane(recoverable.id, {
      eventBuffer: [
        ...streamFromMetadata(
          decodeMetadataValue(recoverable.metadata ?? null)
        ),
      ],
    });

    if (recoverable.lastStatus === "suspended") {
      const recoveredState = workflowStateFromMetadata(
        decodeMetadataValue(recoverable.metadata ?? null),
        "suspended"
      );
      Effect.runSync(
        workflowEffectAccess(workflow).seedState({
          ...recoveredState,
          status: "suspended",
        })
      );
      const erased = dispatched as unknown as DispatchedWorkflow;
      this.#all.set(dispatched.id, erased);
      Effect.runSync(this.#armSuspendResumeReactor(erased));
      this.#emit({ kind: "recovered", runId: recoverable.id });
      return dispatched;
    }

    this.#admit(dispatched as unknown as DispatchedWorkflow, true);
    this.#emit({ kind: "recovered", runId: recoverable.id });
    return dispatched;
  }

  dispatchPersisted<I, O, X extends BaseContext>(
    workflow: Workflow<I, O, X>,
    persisted: RecoverableRun,
    afterCommit: (operation: () => void) => void = (operation) => {
      operation();
    }
  ): DispatchedWorkflow<I, O, X> {
    this.#assertPersistedAdmissionAllowed(persisted.id, "dispatchPersisted");
    const dispatched = new DispatchedWorkflow<I, O, X>({
      id: persisted.id,
      persist: (snap) =>
        Effect.runPromise(
          this.#persistSnapshot(
            persisted.id,
            persisted.step,
            snap,
            workflow.persistence
          )
        ),
      queueId: this.id,
      step: persisted.step,
      workflow,
      ...(this.#opts.onRunCancelled
        ? {
            onCancel: (snap: WorkflowState) =>
              this.#notifyRunCancelled(
                persisted.id,
                persisted.step,
                snap,
                workflow.persistence
              ),
          }
        : {}),
      authorityManagedSuspensions: this.#opts.onRunSuspended !== undefined,
      withControl: (operation) => this.withRunControl(persisted.id, operation),
    });
    afterCommit(() => {
      this.#assertPersistedAdmissionAllowed(persisted.id, "dispatchPersisted");
      this.#openLane(persisted.id, {
        eventBuffer: [
          ...streamFromMetadata(
            decodeMetadataValue(persisted.metadata ?? null)
          ),
        ],
      });
      this.#admit(dispatched as unknown as DispatchedWorkflow, true);
    });
    return dispatched;
  }

  #assertPersistedAdmissionAllowed(id: string, action: string): void {
    this.#assertServing(action);
    if (this.#all.has(id)) {
      throw new RecordAlreadyExistsError("run", id);
    }
  }

  #assertServing(action: string): void {
    if (this.#shutdownPromise !== null) {
      throw new Error(
        `Queue ${this.id} is shut down; ${action} is not accepted`
      );
    }
    if (this.#fatalError !== null) {
      throw new Error(
        `Queue ${this.id} has a fatal persistence failure; restart recovery is required before ${action}`,
        { cause: this.#fatalError }
      );
    }
  }

  async findRecoverableRuns(): Promise<readonly RecoverableRun[]> {
    await this.#queueInsertPromise;
    return this.#store.findRecoverableRuns(this.id);
  }

  async hydrate<I, O, X extends BaseContext>(
    runId: string,
    factory: (
      recoverable: RecoverableRun
    ) => Workflow<I, O, X> | Promise<Workflow<I, O, X>>
  ): Promise<DispatchedWorkflow<I, O, X> | null> {
    const cached = this.#all.get(runId);
    if (cached) {
      return cached as unknown as DispatchedWorkflow<I, O, X>;
    }

    await this.#queueInsertPromise;

    const row = await this.#store.getRun(runId);
    if (!row) {
      return null;
    }

    const decoded = decodeMetadataValue(row.metadata);
    const recoverable = rowToRecoverable(row);
    const workflow = await factory(recoverable);

    const seedSteps = stepsFromMetadata(decoded);
    if (seedSteps !== null) {
      await Effect.runPromise(workflow.root.snapshot.seed(seedSteps));
    }

    const persistedWorkflow = workflowStateFromMetadata(decoded, row.status);
    await workflow.seedState(persistedWorkflow);

    const dispatched = new DispatchedWorkflow<I, O, X>({
      id: row.id,
      queueId: this.id,
      workflow,
      ...(row.step ? { step: row.step } : {}),
      persist: (snap) =>
        Effect.runPromise(
          this.#persistSnapshot(row.id, row.step, snap, workflow.persistence)
        ),
      ...(this.#opts.onRunCancelled
        ? {
            onCancel: (snap: WorkflowState) =>
              this.#notifyRunCancelled(
                row.id,
                row.step,
                snap,
                workflow.persistence
              ),
          }
        : {}),
      authorityManagedSuspensions: this.#opts.onRunSuspended !== undefined,
      withControl: (operation) => this.withRunControl(row.id, operation),
    });
    const erased = dispatched as unknown as DispatchedWorkflow;
    this.#all.set(row.id, erased);

    this.#openLane(row.id, {
      eventBuffer: [...streamFromMetadata(decoded)],
    });

    if (row.status === "suspended") {
      await Effect.runPromise(this.#armSuspendResumeReactor(erased));
    }

    return dispatched;
  }

  active(): readonly DispatchedWorkflow[] {
    return [...this.#all.values()].filter((r) => r.status === "running");
  }

  pending(): readonly DispatchedWorkflow[] {
    return [...this.#all.values()].filter((r) => r.status === "queued");
  }

  size(): Promise<QueueSize> {
    const tally: Record<keyof QueueSize, number> = {
      active: 0,
      cancelled: 0,
      complete: 0,
      failed: 0,
      pending: 0,
      suspended: 0,
    };
    const bucket: Partial<Record<RunStatus, keyof QueueSize>> = {
      cancelled: "cancelled",
      complete: "complete",
      failed: "failed",
      queued: "pending",
      running: "active",
      suspended: "suspended",
    };
    for (const run of this.#all.values()) {
      const key = bucket[run.status];
      if (key) {
        tally[key] += 1;
      }
    }
    return Promise.resolve(tally);
  }

  pause(): Promise<void> {
    this.#telemetry.setMetric("queue.paused", 1);
    this.#events.log("info", "Queue paused");
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* SubscriptionRef.set(self.#pausedRef, true);
        yield* self.#updateQueueStatus("paused");
      })
    );
  }

  resume(): Promise<void> {
    if (this.#fatalError !== null) {
      return Promise.reject(
        new Error(
          `Queue ${this.id} has a fatal persistence failure; restart recovery is required before resume`,
          { cause: this.#fatalError }
        )
      );
    }
    this.#telemetry.setMetric("queue.paused", 0);
    this.#events.log("info", "Queue resumed");
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* SubscriptionRef.set(self.#pausedRef, false);
        yield* self.#updateQueueStatus("active");
      })
    );
  }

  drain(opts?: { graceMs?: number }): Promise<void> {
    const graceMs = opts?.graceMs;
    if (graceMs !== undefined && (!Number.isFinite(graceMs) || graceMs < 0)) {
      return Promise.reject(
        new RangeError(
          "Queue drain graceMs must be a finite non-negative number"
        )
      );
    }
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        const out = yield* SubscriptionRef.get(self.#outstandingRef);
        if (out === 0) {
          return;
        }
        const wasPaused = yield* SubscriptionRef.get(self.#pausedRef);
        yield* self.#updateQueueStatus("draining");
        const waitForIdle = self.#outstandingRef.changes.pipe(
          Stream.filter((n) => n === 0),
          Stream.take(1),
          Stream.runDrain
        );
        const wait =
          graceMs === undefined
            ? waitForIdle
            : Effect.race(
                waitForIdle.pipe(Effect.as(false)),
                Effect.sleep(graceMs).pipe(Effect.as(true))
              ).pipe(
                Effect.flatMap((timedOut) =>
                  timedOut
                    ? Effect.fail(
                        new Error(
                          `Queue ${self.id} did not drain within ${String(graceMs)} ms`
                        )
                      )
                    : Effect.void
                )
              );
        yield* wait.pipe(
          Effect.ensuring(
            self.#updateQueueStatus(wasPaused ? "paused" : "active")
          )
        );
      })
    );
  }

  shutdown(opts?: { graceMs?: number }): Promise<void> {
    if (this.#shutdownPromise !== null) {
      return this.#shutdownPromise;
    }
    const graceMs = opts?.graceMs ?? 30_000;
    const self = this;
    this.#shutdownPromise = Effect.runPromise(
      Effect.gen(function* () {
        yield* SubscriptionRef.set(self.#pausedRef, true);
        yield* Effect.race(
          Effect.tryPromise({
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
            try: () => self.drain(),
          }).pipe(Effect.catchAll(() => Effect.void)),
          Effect.sleep(graceMs)
        );
        if (self.#driverFiber !== null) {
          yield* Fiber.interrupt(self.#driverFiber);
        }
        yield* self.#updateQueueStatus("stopped");
        yield* Scope.close(self.#scope, Exit.void);
      })
    );
    return this.#shutdownPromise;
  }

  on(
    event: QueueEvent,
    handler: (payload: QueueEventPayload) => void
  ): Unsubscribe {
    return this.#events.on(event, handler);
  }

  #supervisedDriverLoop(): Effect.Effect<void> {
    const self = this;
    const retrySchedule = Schedule.exponential("100 millis").pipe(
      Schedule.compose(Schedule.recurs(5))
    );
    return self.#driverLoop().pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          const err: unknown = error;
          const e = err instanceof Error ? err : new Error(String(err));
          self.#events.queueLevel("restarted", { error: e });
        })
      ),
      Effect.retry(retrySchedule),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const err: unknown = error;
          const e = err instanceof Error ? err : new Error(String(err));
          self.#events.queueLevel("queue_failed", { error: e });
          yield* self.#updateQueueStatus("stopped");
        })
      )
    );
  }

  #driverLoop(): Effect.Effect<void> {
    const self = this;
    let admittedSinceHostYield = 0;
    const waitUntilUnpaused = Effect.gen(function* () {
      const paused = yield* SubscriptionRef.get(self.#pausedRef);
      if (paused) {
        yield* self.#pausedRef.changes.pipe(
          Stream.filter((p) => !p),
          Stream.take(1),
          Stream.runDrain
        );
      }
    });
    return Effect.forever(
      Effect.gen(function* () {
        yield* waitUntilUnpaused;
        const run = yield* EffectQueue.take(self.#pendingQueue);
        yield* waitUntilUnpaused;
        yield* Effect.fork(self.#semaphore.withPermits(1)(self.#runOne(run)));
        admittedSinceHostYield += 1;
        if (admittedSinceHostYield >= self.#opts.concurrency) {
          admittedSinceHostYield = 0;
          yield* yieldToHost();
        }
      })
    );
  }

  #confirmAdmission(run: DispatchedWorkflow): Effect.Effect<boolean> {
    const self = this;
    const insertPromise = self.#lanes.get(run.id)?.insertPromise;
    if (!insertPromise) {
      return Effect.succeed(true);
    }

    return Effect.tryPromise({
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
      try: () => insertPromise,
    }).pipe(
      Effect.as<Error | null>(null),
      Effect.catchAll((error) => Effect.succeed(error)),
      Effect.flatMap((admissionError) => {
        if (!admissionError) {
          return Effect.succeed(true);
        }
        return Effect.gen(function* () {
          self.#admissionFailures.set(run.id, admissionError);
          yield* run._rejectAdmission(admissionError);
          self.#events.run("failed", run);
          self.#emit({
            error: errorToShape(admissionError),
            kind: "failed",
            runId: run.id,
          });
          return false;
        });
      })
    );
  }

  #startRun(
    run: DispatchedWorkflow,
    workflow: ReturnType<typeof workflowEffectAccess>
  ): Effect.Effect<RunStartOutcome, Error> {
    return Effect.tryPromise({
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
      try: () =>
        this.withRunControl(run.id, async () => {
          if (this.#cancelledBeforeStart.delete(run.id)) {
            return "cancelled-before-start" as const;
          }
          const authoritative = await this.#store.getRun(run.id);
          if (authoritative?.status === "cancelled") {
            await run._cancelAfterAuthorityUnlocked();
            this.#events.run("cancelled", run);
            this.#emit({ kind: "cancelled", runId: run.id });
            return "cancelled-before-start" as const;
          }
          await Effect.runPromise(
            workflow.markStarted(new Date().toISOString())
          );
          const startSnap = await Effect.runPromise(workflow.state);
          await Effect.runPromise(
            this.#persistSnapshot(
              run.id,
              run.step,
              { ...startSnap, status: "running" },
              run.workflow.persistence
            )
          );
          this.#driverOwned.add(run.id);
          return "started" as const;
        }),
    });
  }

  #driveRun(
    workflow: ReturnType<typeof workflowEffectAccess>
  ): Effect.Effect<void> {
    return Effect.race(
      workflow.run().pipe(Effect.catchAll(() => Effect.void)),
      workflow.statusChanges.pipe(
        Stream.filter((status) => status === "cancelled"),
        Stream.take(1),
        Stream.runDrain
      )
    );
  }

  #observeRun(
    run: DispatchedWorkflow,
    workflow: ReturnType<typeof workflowEffectAccess>
  ): Effect.Effect<WorkflowState> {
    const self = this;
    return Effect.gen(function* () {
      const persist = yield* Effect.fork(self.#persistenceLoop(run));
      const ready = yield* Deferred.make<void>();
      const eventLog = yield* Effect.fork(self.#eventLogLoop(run, ready));
      yield* Deferred.await(ready);
      yield* self
        .#driveRun(workflow)
        .pipe(
          Effect.ensuring(
            Fiber.interrupt(persist).pipe(
              Effect.zipRight(Fiber.interrupt(eventLog))
            )
          )
        );
      const state = yield* workflow.state;
      return { ...state, status: run.status };
    });
  }

  #settleSuspension(
    run: DispatchedWorkflow,
    snapshot: WorkflowState
  ): Effect.Effect<RunFinishOutcome, Error> {
    const self = this;
    return Effect.gen(function* () {
      self.#driverOwned.delete(run.id);
      const { suspension } = run.snapshot;
      const { onRunSuspended } = self.#opts;

      if (onRunSuspended) {
        if (!suspension) {
          return yield* Effect.fail(
            new Error(`Suspended Run ${run.id} has no suspension state`)
          );
        }
        const fields = yield* self.#snapshotRunPatch(
          run.id,
          run.step,
          snapshot,
          run.workflow.persistence
        );
        const parkingError = yield* Effect.tryPromise({
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
          try: () =>
            onRunSuspended(run.id, run.step, suspension, withoutStatus(fields)),
        }).pipe(
          Effect.as<Error | null>(null),
          Effect.tapError((error) =>
            Effect.sync(() => {
              self.#events.queueLevel("persist_failed", {
                error,
                runId: run.id,
                step: run.step,
              });
            })
          ),
          Effect.catchAll((error) => Effect.succeed(error))
        );

        if (parkingError) {
          const terminalWriteError = yield* self
            .#persistSnapshotStrict(
              run.id,
              run.step,
              {
                ...snapshot,
                completedAt: new Date().toISOString(),
                error: errorToShape(parkingError),
                status: "failed",
              },
              run.workflow.persistence
            )
            .pipe(
              Effect.as<Error | null>(null),
              Effect.catchAll((error) => Effect.succeed(error))
            );
          if (terminalWriteError) {
            self.#fatalError = terminalWriteError;
            self.#events.queueLevel("queue_failed", {
              error: terminalWriteError,
              runId: run.id,
              step: run.step,
            });
            yield* SubscriptionRef.set(self.#pausedRef, true);
            yield* self.#updateQueueStatus("stopped");
            return { kind: "fatal" };
          }

          yield* run._rejectInfrastructure(parkingError);
          self.#events.run("failed", run);
          self.#emit({
            error: errorToShape(parkingError),
            kind: "failed",
            runId: run.id,
          });
          return { kind: "terminal" };
        }
      } else {
        yield* self.#persistSnapshot(
          run.id,
          run.step,
          snapshot,
          run.workflow.persistence
        );
      }

      self.#events.run("suspended", run);
      self.#emit({
        at: suspension?.name ?? "",
        kind: "suspended",
        runId: run.id,
      });
      yield* self.#armSuspendResumeReactor(run);
      return { kind: "parked" };
    });
  }

  #settleTerminal(
    run: DispatchedWorkflow,
    snapshot: WorkflowState,
    workflow: ReturnType<typeof workflowEffectAccess>
  ): Effect.Effect<RunFinishOutcome, Error> {
    const self = this;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Terminal settlement keeps persistence, cancellation authority, events, and promise settlement in their required order.
    return Effect.gen(function* () {
      let { status } = run;
      if (status === "complete" || status === "failed") {
        const terminalWriteError = yield* self
          .#persistSnapshotStrict(
            run.id,
            run.step,
            snapshot,
            run.workflow.persistence
          )
          .pipe(
            Effect.as<Error | null>(null),
            Effect.catchAll((error) => Effect.succeed(error))
          );
        if (terminalWriteError) {
          if (!(terminalWriteError instanceof RunAlreadySettledError)) {
            return yield* Effect.fail(terminalWriteError);
          }
          const authoritative = yield* Effect.tryPromise({
            catch: (error) =>
              error instanceof Error ? error : new Error(String(error)),
            try: () => self.#store.getRun(run.id),
          });
          if (authoritative?.status !== "cancelled") {
            return yield* Effect.fail(terminalWriteError);
          }
          yield* Effect.tryPromise({
            catch: (error) =>
              error instanceof Error ? error : new Error(String(error)),
            try: () => run._cancelLiveAfterAuthority(),
          });
          status = "cancelled";
        }
      }

      const terminalSnapshot: WorkflowState =
        status === snapshot.status ? snapshot : { ...run.snapshot, status };
      const { onRunCancelled } = self.#opts;
      if (status === "cancelled" && onRunCancelled) {
        const fields = yield* self.#snapshotRunPatch(
          run.id,
          run.step,
          terminalSnapshot,
          run.workflow.persistence
        );
        yield* Effect.tryPromise({
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
          try: () => onRunCancelled(run.id, withoutStatus(fields)),
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              self.#events.queueLevel("persist_failed", {
                error,
                runId: run.id,
                step: run.step,
              });
            })
          )
        );
      } else if (status !== "complete" && status !== "failed") {
        yield* self.#persistSnapshot(
          run.id,
          run.step,
          terminalSnapshot,
          run.workflow.persistence
        );
      }

      if (status === "complete") {
        self.#events.run("complete", run);
        self.#emit({ kind: "completed", output: run.output, runId: run.id });
      } else if (status === "failed") {
        self.#events.run("failed", run);
        self.#emit({
          error: run.error ?? { message: "Workflow failed", name: "Error" },
          kind: "failed",
          runId: run.id,
        });
      } else if (status === "cancelled") {
        self.#events.run("cancelled", run);
        self.#emit({ kind: "cancelled", runId: run.id });
      }

      const result =
        status === "cancelled"
          ? ({ status: "cancelled" } as const)
          : yield* workflow.result;
      yield* run._settle(result);
      return { kind: "terminal" };
    });
  }

  #finishRun(
    run: DispatchedWorkflow,
    outcome: RunFinishOutcome
  ): Effect.Effect<void> {
    if (outcome.kind === "fatal") {
      return Effect.void;
    }

    if (outcome.kind === "terminal") {
      this.#driverOwned.delete(run.id);
    }
    if (outcome.kind !== "parked") {
      this.#closeLane(run.id);
    }
    return this.#releaseOutstanding(run.id);
  }

  #runOne(run: DispatchedWorkflow): Effect.Effect<void, Error> {
    const self = this;
    return Effect.gen(function* () {
      const workflow = workflowEffectAccess(run.workflow);
      const admitted = yield* self.#confirmAdmission(run);
      if (!admitted) {
        yield* self.#finishRun(run, { kind: "rejected" });
        return;
      }

      const start = yield* self.#startRun(run, workflow);
      if (start === "cancelled-before-start") {
        yield* self.#finishRun(run, { kind: "cancelled-before-start" });
        return;
      }

      self.#events.run("started", run, "running");
      self.#emit({ kind: "started", runId: run.id });

      const correctedSnap = yield* self.#observeRun(run, workflow);
      if (run.status === "suspended") {
        const outcome = yield* self.#settleSuspension(run, correctedSnap);
        yield* self.#finishRun(run, outcome);
        return;
      }

      const outcome = yield* self.#settleTerminal(run, correctedSnap, workflow);
      yield* self.#finishRun(run, outcome);
    }).pipe(
      Effect.withSpan("workflows.queue.run", {
        attributes: {
          queueId: self.id,
          runId: run.id,
          step: run.step,
        },
      })
    );
  }

  #armSuspendResumeReactor(run: DispatchedWorkflow): Effect.Effect<void> {
    const self = this;
    const workflow = workflowEffectAccess(run.workflow);
    return Effect.forkDaemon(
      workflow.statusChanges.pipe(
        Stream.filter((s) => s === "queued"),
        Stream.take(1),
        Stream.runDrain,
        Effect.zipRight(
          Effect.gen(function* () {
            self.#resumeReactors.delete(run.id);
            self.#events.run("resumed", run);
            self.#emit({
              at: run.snapshot.suspension?.name ?? "",
              kind: "resumed",
              runId: run.id,
            });
            yield* self.#acquireOutstanding(run.id);
            yield* EffectQueue.offer(self.#pendingQueue, run);
          })
        )
      )
    ).pipe(
      Effect.tap((reactor) =>
        Effect.sync(() => this.#resumeReactors.set(run.id, reactor))
      ),
      Effect.asVoid
    );
  }

  #persistenceLoop(run: DispatchedWorkflow): Effect.Effect<void> {
    let last: WorkflowState["status"] = "running";
    return workflowEffectAccess(run.workflow).stateChanges.pipe(
      Stream.drop(1),
      Stream.map((snap) => {
        const status =
          snap.status === "queued" && last === "running"
            ? ("running" as const)
            : snap.status;
        last = status;
        return status === snap.status ? snap : { ...snap, status };
      }),
      Stream.filter(
        (snap) =>
          !(
            (snap.status === "suspended" && this.#opts.onRunSuspended) ||
            (snap.status === "cancelled" && this.#opts.onRunCancelled)
          )
      ),
      Stream.tap((snap) =>
        this.#persistSnapshot(run.id, run.step, snap, run.workflow.persistence)
      ),
      Stream.runDrain,
      Effect.catchAll(() => Effect.void)
    );
  }

  #eventLogLoop(
    run: DispatchedWorkflow,
    ready: Deferred.Deferred<void>
  ): Effect.Effect<void> {
    const self = this;
    return Effect.scoped(
      Effect.gen(function* () {
        const dequeue = yield* PubSub.subscribe(
          run.workflow.root.channels.events.pubsub
        );
        yield* Deferred.succeed(ready, undefined);
        yield* Stream.fromQueue(dequeue).pipe(
          Stream.filter(
            (event) => event._tag !== "step.progress" && event._tag !== "custom"
          ),
          Stream.tap((event) =>
            Effect.sync(() => {
              const buffer = self.#lanes.get(run.id)?.eventBuffer;
              if (buffer) {
                buffer.push(event);
              }
            })
          ),
          Stream.runDrain
        );
      })
    ).pipe(Effect.catchAll(() => Effect.void));
  }

  #persistSnapshot(
    runId: string,
    step: string,
    snap: WorkflowState,
    policy: WorkflowPersistence
  ): Effect.Effect<void> {
    return this.#persistSnapshotStrict(runId, step, snap, policy).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          this.#events.queueLevel("persist_failed", {
            error,
            runId,
            step,
          });
        })
      )
    );
  }

  #persistSnapshotStrict(
    runId: string,
    step: string,
    snap: WorkflowState,
    policy: WorkflowPersistence
  ): Effect.Effect<void, Error> {
    const write: Effect.Effect<void, Error> = this.#snapshotRunPatch(
      runId,
      step,
      snap,
      policy
    ).pipe(
      Effect.flatMap((fields) =>
        Effect.tryPromise({
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
          try: () => this.#store.updateRun(runId, fields),
        })
      ),
      Effect.flatMap((record): Effect.Effect<void, Error> => {
        if (record === null) {
          return Effect.fail(new RunNotFoundError(runId));
        }
        if (record.status !== snap.status) {
          return Effect.fail(new RunAlreadySettledError(runId));
        }
        return Effect.void;
      })
    );
    const mutex = this.#lanes.get(runId)?.writeMutex;
    return mutex ? mutex.withPermits(1)(write) : write;
  }

  #snapshotRunPatch(
    runId: string,
    step: string,
    snap: WorkflowState,
    policy: WorkflowPersistence
  ): Effect.Effect<UpdateRunInput, Error> {
    return Effect.try({
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
      try: () => {
        const metadata = encodePersistedMetadata(
          { ...snap, runId, step },
          [...(this.#lanes.get(runId)?.eventBuffer ?? [])],
          policy
        );
        return {
          status: snap.status,
          ...(snap.output === undefined || policy.results === "transient"
            ? {}
            : { output: snap.output }),
          ...(snap.error === undefined ? {} : { error: snap.error }),
          ...(snap.tree === null ? {} : { snapshot: snap.tree }),
          metadata,
          ...(snap.startedAt
            ? { timestamps: { startedAt: Date.parse(snap.startedAt) } }
            : {}),
          ...(snap.completedAt
            ? {
                timestamps:
                  snap.status === "complete"
                    ? { completedAt: Date.parse(snap.completedAt) }
                    : { failedAt: Date.parse(snap.completedAt) },
              }
            : {}),
        };
      },
    });
  }

  #updateQueueStatus(status: QueueStatus): Effect.Effect<void> {
    return Effect.tryPromise({
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      try: () =>
        this.#queueInsertPromise.then(() =>
          this.#store.updateQueue(this.id, { status })
        ),
    }).pipe(
      Effect.asVoid,
      Effect.catchAll((err) =>
        Effect.sync(() => {
          this.#events.queueLevel("persist_failed", { error: err });
        })
      )
    );
  }

  async #notifyRunCancelled(
    runId: string,
    step: string,
    snapshot: WorkflowState,
    policy: WorkflowPersistence
  ): Promise<void> {
    const callback = this.#opts.onRunCancelled;
    if (!callback) {
      return;
    }
    const fields = await Effect.runPromise(
      this.#snapshotRunPatch(runId, step, snapshot, policy)
    );
    try {
      await callback(runId, withoutStatus(fields));
    } catch (error) {
      this.#events.queueLevel("persist_failed", {
        error: error instanceof Error ? error : new Error(String(error)),
        runId,
        step,
      });
      throw error;
    }
  }

  #emit(event: RunLifecycleEvent): void {
    try {
      this.#logger.on(event);
    } catch {
      // biome-ignore lint/complexity/noUselessReturn: End the best-effort operation on failure.
      return;
    }
  }
}

function withoutStatus(fields: UpdateRunInput): Omit<UpdateRunInput, "status"> {
  const { status: _status, ...patch } = fields;
  return patch;
}
