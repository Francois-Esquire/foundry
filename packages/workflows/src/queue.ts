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
import { errorToShape } from "./helpers";
import { workflowEffectAccess } from "./internal/workflow-effect-access";
import type { OrchestratorLogger, RunLifecycleEvent } from "./logger";
import { BaseOrchestratorLogger } from "./logger";
import type { PersistedWorkflow } from "./metadata-codec";
import {
  decodeMetadataValue,
  encodePersistedMetadata,
  rowToRecoverable,
  stepsFromMetadata,
  streamFromMetadata,
  workflowStateFromMetadata,
} from "./metadata-codec";
import { QueueEvents } from "./queue-events";
import type {
  DispatchOptions,
  QueueEvent,
  QueueEventPayload,
  QueueOptions,
  QueueSize,
  RecoverableRun,
} from "./queue-types";
import type { OrchestratorStore, RunLinks, UpdateRunInput } from "./store";
import { InMemoryOrchestratorStore } from "./store";
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

// Re-exported to preserve the file-based public subpaths these symbols
// resolved under before extraction (`@foundry/workflows/queue`).
export { DispatchedWorkflow } from "./dispatched-workflow";
export type {
  DispatchOptions,
  QueueEvent,
  QueueEventPayload,
  QueueOptions,
  QueueSize,
  RecoverableRun,
} from "./queue-types";

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

/**
 * Queue — the dispatched-execution surface.
 *
 * Runs dispatched workflows at a configurable concurrency limit in FIFO order,
 * manages their durable lifecycle through an OrchestratorStore. Dispatches
 * are optional — Steps and Workflows work standalone. An internal semaphore
 * enforces concurrency; a forked driver pulls runs from an unbounded queue and
 * acquires permits before execution.
 *
 * Public API: `dispatch()` returns synchronously; `pause()`, `resume()`,
 * `drain()`, `get()`, `size()` return Promises.
 * Persistence defaults to an in-memory store; production compositions supply
 * a durable OrchestratorStore.
 *
 * @example
 *   const queue = new Queue({ store, concurrency: 4 });
 *   const run = queue.dispatch(myWorkflow, { city: "Tokyo" });
 *   const result = await run.result();
 */
export class Queue {
  readonly id: string;
  readonly #opts: QueueOptions;
  readonly #store: OrchestratorStore;
  readonly #logger: OrchestratorLogger;
  readonly #telemetry: Telemetry;

  // Effect-native concurrency / pending / pause primitives.
  readonly #semaphore: Effect.Semaphore;
  readonly #pendingQueue: EffectQueue.Queue<DispatchedWorkflow>;
  readonly #pausedRef: SubscriptionRef.SubscriptionRef<boolean>;
  // Outstanding = dispatched runs that haven't yet settled to
  // terminal-or-suspended. Incremented on dispatch (sync, before
  // offering to the queue, so drain never sees a transient zero
  // between take and #runOne start) and decremented when a run
  // releases its slot. Used by drain to await idle.
  readonly #outstandingRef: SubscriptionRef.SubscriptionRef<number>;

  // Id → handle index for `get(id)` and accessors (`active`, `pending`, `size`).
  // Mutated only in dispatch; suspended runs re-enqueue via #runOne's listener.
  readonly #all = new Map<string, DispatchedWorkflow>();
  // Queue-wide event firehose + telemetry/log sink (the public-API plain-JS
  // surface behind `on()`). Shares the Queue's Telemetry instance.
  readonly #events: QueueEvents;

  // Driver-loop fiber handle, captured at construction. Held for
  // shutdown() to interrupt cleanly.
  #driverFiber: ReturnType<typeof Effect.runFork> | null = null;
  // Idempotent shutdown gate. Once set, dispatch rejects and a second
  // shutdown call returns the same in-flight promise.
  #shutdownPromise: Promise<void> | null = null;

  // Promise for ensuring the queue record. Chained in dispatch so persistent
  // stores always observe the queue before a run.
  readonly #queueInsertPromise: Promise<unknown>;

  // Per-run transient lane: the write mutex, append-only event-log buffer, and
  // optional row-insert promise that share a single lifecycle. Created together
  // at run admission (dispatch/adopt/hydrate) and dropped together at terminal
  // settle, so "the three agree on key set" is a type fact, not discipline.
  // (Separate from #all, which is the permanent id→handle index.)
  readonly #lanes = new Map<string, RunLane>();

  // Admission failures outlive the transient run lane so callers that attach
  // after the driver has rejected an insert still observe the durable failure.
  // Successful admissions need no tombstone: absence means persistence
  // completed successfully once the lane has closed.
  readonly #admissionFailures = new Map<string, Error>();
  readonly #controlTails = new Map<string, Promise<void>>();
  readonly #cancelledBeforeStart = new Set<string>();
  readonly #driverOwned = new Set<string>();
  readonly #outstandingOwned = new Set<string>();
  #fatalError: Error | null = null;

  // Long-lived scope for hydrated runs and their forked subscribers
  // (status/state mirrors). Closes on shutdown().
  readonly #scope: Scope.CloseableScope;

  constructor(opts: QueueOptions) {
    this.#opts = opts;
    this.id = opts.id ?? generateId("qu");
    this.#store = opts.store ?? new InMemoryOrchestratorStore();
    this.#queueInsertPromise = this.#store.ensureQueue({
      extensions: opts.extensions,
      id: this.id,
      name: this.id,
    });

    this.#scope = Effect.runSync(Scope.make());
    this.#telemetry = new Telemetry();
    this.#logger = opts.logger ?? new BaseOrchestratorLogger();
    this.#events = new QueueEvents({ id: this.id, telemetry: this.#telemetry });
    // Allocate Effect primitives synchronously (each is a sync alloc
    // expressed as an Effect; runSync is safe).
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

    // Fork driver loop with retry supervisor: 5 restarts (exponential backoff,
    // 100ms → 1.6s). Emit 'restarted' on retry, 'queue_failed' on exhaustion.
    // Interruption bypasses retry.
    this.#driverFiber = Effect.runFork(this.#supervisedDriverLoop());
  }

  /** The configuration this queue was constructed with. */
  get options(): QueueOptions {
    return this.#opts;
  }

  /** Cumulative metrics + log ring buffer for this Queue. */
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

    // Fire the row insert immediately. Chained off the queue's own
    // insert because `runs.queueId` has an FK to `queues.id`. The
    // persistence subscriber in #runOne awaits this before any
    // updates are issued.
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

  /** Resolve once dispatch has established the durable run record. */
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

  /** Idempotent per-run lane: write mutex + event buffer (+ optional row-insert
   *  promise). Created at admission by dispatch/adopt/hydrate, dropped at terminal
   *  settle. Returns the existing lane if already open (adopt/hydrate may re-open). */
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

  /** Index a run, announce it, and offer it to the driver. Outstanding is
   * bumped *before* the offer so drain never sees a transient zero. */
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
    void Effect.runPromise(
      deferExecution ? yieldToHost().pipe(Effect.zipRight(offer)) : offer
    ).catch(() => undefined);
  }

  /** Look up a previously-dispatched run by id. */
  get(runId: string): Promise<DispatchedWorkflow | null> {
    return Promise.resolve(this.#all.get(runId) ?? null);
  }

  /** @internal Serialize externally-triggered state transitions per Run. */
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

  /** @internal Project already-committed cancellation into a local handle. */
  async applyAuthoritativeCancellation(runId: string): Promise<void> {
    const run = this.#all.get(runId);
    if (!run) {
      return;
    }
    await this.withRunControl(runId, async () => {
      const status = run.status;
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

  // ── JS-first runId accessors (in-memory hit OR DB fallthrough)
  // Live runs read from snapshot; persisted runs read from row metadata.
  // For full live handles (resume/cancel/result), use hydrate(runId, factory).

  /**
   * Decode-once reader for the DB-fallthrough accessors. Returns the row's
   * authoritative status plus the persisted `metadata.workflow` blob (or `null`
   * when no row exists); the four accessors below project from this one decode.
   */
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

  /**
   * Run status by id. `null` if no row exists. In-memory hit reads
   * synchronously via the live handle; otherwise reads `runs.status`
   * directly off the row.
   */
  async status(runId: string): Promise<RunStatus | null> {
    const cached = this.#all.get(runId);
    if (cached) {
      return cached.status;
    }
    return (await this.#readPersisted(runId))?.status ?? null;
  }

  /**
   * Workflow snapshot by id. Returns the full `WorkflowState` projection
   * (input, output, status, suspension, error, steps, telemetry…). For
   * live runs this is the in-memory SubscriptionRef; for persisted runs
   * it's the parsed `metadata.workflow` blob fortified with the row's
   * authoritative status.
   */
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

  /**
   * Path-keyed map of completed step outputs. For live runs reads the
   * in-memory results projection; for persisted runs derives the map
   * from `metadata.workflow.steps` (any step with status='complete' and
   * a populated `output` contributes an entry). Returns `null` if no
   * row exists, or `{}` if a row exists but no step has completed yet.
   */
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
        out[key] = step.output;
      }
    }
    return out;
  }

  /**
   * Workflow-level error shape by id. `null` for runs that haven't
   * failed (queued/running/suspended/complete/cancelled) or for
   * missing runIds. Live hit reads the in-memory `error` accessor;
   * persisted hit reads `metadata.workflow.error`.
   */
  async error(runId: string): Promise<ErrorShape | null> {
    const cached = this.#all.get(runId);
    if (cached) {
      return cached.error;
    }
    return (await this.#readPersisted(runId))?.workflow?.error ?? null;
  }

  /**
   * Re-enqueue a recovered run using its persisted id without inserting a new row.
   * The caller is responsible for rebuilding the Workflow with snapshot pre-seeded
   * from recoverable.metadata so skip-on-complete fires for already-completed steps.
   * Suspended rows are indexed and parked without driver admission; their
   * resume reactor enqueues only after authority records a resolution.
   */
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
    // Recovered runs share the same lifecycle hazards as fresh dispatches:
    // the persistence subscriber writes alongside the terminal write, both
    // need to serialize through a single per-run lane.
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

  /**
   * Admit a freshly-created durable Run without inserting it a second time.
   * Unlike {@link adopt}, this is normal dispatch and emits no recovery event.
   */
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

  /**
   * Return all non-terminal rows for this queue (status IN 'queued',
   * 'initializing', 'running', 'suspended'). For cold-start recovery: the
   * caller rebuilds each Workflow via a registry (matching `step` to factory)
   * and re-dispatches via `adopt()`. For suspended rows, call
   * `dispatched.resume(suspension.name, resolution)` after dispatch.
   */
  async findRecoverableRuns(): Promise<readonly RecoverableRun[]> {
    await this.#queueInsertPromise;
    return this.#store.findRecoverableRuns(this.id);
  }

  /**
   * Rebuild the in-memory `DispatchedWorkflow` handle for a persisted run
   * without re-enqueuing it. The hydrated handle's sync accessors read from
   * seeded SubscriptionRefs. Idempotent: returns cached handle if already
   * hydrated or currently live. Returns `null` if no row exists.
   *
   * The factory is an ordinary synchronous or Promise-returning TypeScript
   * function. Typical implementations read `recoverable.step` to select a
   * registered workflow factory.
   *
   * Hydrate does NOT re-execute the workflow body. To resume a suspended
   * hydrated run, call `dispatched.resume(name, value)`. To re-enqueue from
   * queued/initializing/running, use `Orchestrator.recover` which calls `adopt`.
   */
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

    // Seed the underlying Snapshot (steps + derived results).
    const seedSteps = stepsFromMetadata(decoded);
    if (seedSteps !== null) {
      await Effect.runPromise(workflow.root.snapshot.seed(seedSteps));
    }

    // Seed the Workflow's own #status / #state SubscriptionRefs from
    // the persisted top-level fields (status, output, suspension, error,
    // timestamps). Without this, the JS-first sync accessors on
    // DispatchedWorkflow read fresh "queued" defaults regardless of
    // the row's actual lifecycle state.
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

    // Per-run lane: if a hydrated run is later resumed (suspended →
    // resume reactor → re-enqueue → #runOne) the reactive subscriber and
    // terminal write need a serialization lane. The event-log buffer is
    // seeded from the persisted `metadata.stream` so subsequent
    // `#eventLogLoop` appends grow on top of the prior queue's history;
    // without it, the next reactive write would clobber the accumulated
    // event log. Idempotent — `dispatch`/`adopt` may have opened it already.
    this.#openLane(row.id, {
      eventBuffer: [...streamFromMetadata(decoded)],
    });

    // If the hydrated row was suspended, arm the resume reactor now.
    // Without this, `dispatched.resume(name, value)` would flip the
    // SubscriptionRef but no listener would re-enqueue — execution
    // would never proceed. This is what makes "process restart picks
    // up a suspended run from a webhook handler" actually work.
    if (row.status === "suspended") {
      await Effect.runPromise(this.#armSuspendResumeReactor(erased));
    }

    return dispatched;
  }

  /** Currently-executing runs. */
  active(): readonly DispatchedWorkflow[] {
    return [...this.#all.values()].filter((r) => r.status === "running");
  }

  /** Runs queued but not yet started. */
  pending(): readonly DispatchedWorkflow[] {
    return [...this.#all.values()].filter((r) => r.status === "queued");
  }

  /** Counts by status — useful for UI summaries. Statuses without a QueueSize
   * bucket (paused/initializing/reviewing/ready_for_review) are not counted. */
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

  /** Stop accepting new dispatches. In-flight runs continue. */
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

  /** Resume after pause. */
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

  /**
   * Resolves when no pending or in-flight runs remain. Suspended runs do not
   * block drain (parked indefinitely awaiting external resume). Reflects
   * queues.status = 'draining' while waiting, restores prior status on
   * completion or timeout. With `graceMs`, rejects if the queue does not become
   * idle before the deadline.
   */
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

  /**
   * Graceful shutdown. Pauses new dispatches, waits for in-flight runs to drain
   * (up to graceMs, default 30_000), then interrupts the driver fiber and marks
   * the queue stopped. Idempotent. After shutdown, `dispatch()` throws.
   */
  shutdown(opts?: { graceMs?: number }): Promise<void> {
    if (this.#shutdownPromise !== null) {
      return this.#shutdownPromise;
    }
    const graceMs = opts?.graceMs ?? 30_000;
    const self = this;
    this.#shutdownPromise = Effect.runPromise(
      Effect.gen(function* () {
        // Pause first so no new dispatches start.
        yield* SubscriptionRef.set(self.#pausedRef, true);
        // Race drain against grace timeout. Drain returns when
        // outstanding hits zero; sleep returns after graceMs. Either
        // way we proceed to the interrupt.
        yield* Effect.race(
          Effect.tryPromise({
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
            try: () => self.drain(),
          }).pipe(Effect.catchAll(() => Effect.void)),
          Effect.sleep(graceMs)
        );
        // Interrupt the driver loop fiber. Effect.retry doesn't retry
        // interruption; the supervisor's catchAll won't fire on interrupt.
        if (self.#driverFiber !== null) {
          yield* Fiber.interrupt(self.#driverFiber);
        }
        yield* self.#updateQueueStatus("stopped");
        // Close the queue's long-lived scope so any hydrated runs'
        // forked subscribers (state mirrors created at Workflow.create
        // time and pinned via Scope.extend(this.#scope) in hydrate())
        // tear down cleanly.
        yield* Scope.close(self.#scope, Exit.void);
      })
    );
    return this.#shutdownPromise;
  }

  /** Subscribe to queue-wide events (cross-run firehose). */
  on(
    event: QueueEvent,
    handler: (payload: QueueEventPayload) => void
  ): Unsubscribe {
    return this.#events.on(event, handler);
  }

  // ── Driver loop
  // Pulls runs from the unbounded Effect queue, gates on pausedRef,
  // forks each inside a semaphore permit. Concurrency up to the cap.

  /**
   * Wrap the driver loop in a retry schedule. On failure: emit 'restarted' and
   * retry. On exhaustion: emit 'queue_failed', mark queue failed. Interruption
   * bypasses retry.
   */
  #supervisedDriverLoop(): Effect.Effect<void> {
    const self = this;
    const retrySchedule = Schedule.exponential("100 millis").pipe(
      Schedule.compose(Schedule.recurs(5))
    );
    // The loop's E channel is `never` (no typed failures), so reify
    // as `unknown` for a sound runtime check. The block is dead today
    // but kept so future typed failures wire through without re-plumbing.
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
        // Block until unpaused.
        yield* waitUntilUnpaused;
        // Take next pending run (blocks).
        const run = yield* EffectQueue.take(self.#pendingQueue);
        // Re-check pause after take to prevent pause-before-dispatch
        // race conditions.
        yield* waitUntilUnpaused;
        // Fork into a permit-scoped child so multiple runs proceed up
        // to concurrency.
        yield* Effect.fork(self.#semaphore.withPermits(1)(self.#runOne(run)));
        admittedSinceHostYield += 1;
        if (admittedSinceHostYield >= self.#opts.concurrency) {
          admittedSinceHostYield = 0;
          // Continuously-ready Effect/Promise work otherwise stays in the
          // microtask queue long enough to starve host timers and IPC.
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
          const startSnap = await Effect.runPromise(workflow.state);
          await Effect.runPromise(
            this.#persistSnapshot(
              run.id,
              run.step,
              {
                ...startSnap,
                startedAt: new Date().toISOString(),
                status: "running",
              },
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
      const suspension = run.snapshot.suspension;
      const onRunSuspended = self.#opts.onRunSuspended;

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
    return Effect.gen(function* () {
      let status = run.status;
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
      const onRunCancelled = self.#opts.onRunCancelled;
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

      // Persist the "running" transition before forking the reactive subscriber,
      // guaranteeing the row reads "running" the instant the body starts.
      // The in-memory workflow ref still reads "queued" here, so the event
      // status is pinned to the just-persisted transition.
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

  /**
   * Arm the resume reactor for a suspended run. Daemon-forked so it survives
   * the parent fiber returning. On status flip suspended → queued: re-bump the
   * outstanding counter and offer the run back to #pendingQueue. Used by #runOne
   * (live suspends) and hydrate (suspended at rest). One definition; essential
   * for hydrated suspended runs to resume at all.
   */
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
    ).pipe(Effect.asVoid);
  }

  /**
   * Reactive persistence subscriber for a single run. Subscribes to workflow.stateChanges
   * and projects each to the row via #persistSnapshot. The per-run mutex serializes writes;
   * the loop fires on every SubscriptionRef change to keep the row eventually-consistent.
   * The synchronous terminal write at #runOne is the final, authoritative word.
   *
   * Lifetime is the parent fiber's: forked inside #runOne and interrupted before the
   * terminal write so it doesn't clobber the final value.
   *
   * No throttling applied. One write per lifecycle event is fine for current workflow shapes.
   */
  #persistenceLoop(run: DispatchedWorkflow): Effect.Effect<void> {
    return workflowEffectAccess(run.workflow).stateChanges.pipe(
      // SubscriptionRef.changes replays the current value as the first
      // emit. That value is the pre-run state already covered by the
      // synchronous "running" boundary write at #runOne — letting it
      // through here would race the boundary write through the mutex
      // and could clobber it back to a pre-run status. Drop it.
      Stream.drop(1),
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

  /**
   * Append-only event log subscriber. Subscribes to the run's events PubSub
   * synchronously (signalling ready once live) and drains every ChannelEvent into
   * the per-run buffer. The next reactive #persistSnapshot snapshots the buffer
   * into metadata.stream. Subscribing synchronously is critical: lazy subscription
   * would race workflow.run() and miss the first step.started event.
   *
   * Lifetime mirrors #persistenceLoop: forked inside #runOne and interrupted
   * before the terminal write so a trailing event can't sneak in.
   *
   * Two event categories are filtered out of persistence:
   *   - step.progress — author progress ticks; fire many times per second.
   *   - custom (step.emit) — domain events with no volume bound.
   *
   * Lifecycle events (started/complete/failed/etc.) are bounded by step count
   * (tens to low hundreds) and are kept. If bloat occurs, the future fix is a
   * separate events table.
   */
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
        // Subscription is live — unblock the caller so workflow.run can
        // start without racing the first emit.
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

  /**
   * Translate persisted workflow state to DAO update fields and issue the write.
   * Errors are swallowed — persistence is best-effort. Writes for a given runId
   * serialize through the per-run mutex so the reactive subscriber and terminal
   * write never interleave.
   */
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

  /** Persistence boundary for state that must be authoritative before exposure. */
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

  /** Reflect lifecycle transitions (pause/resume/drain/shutdown) to the queues.status row.
   * Best-effort; errors are swallowed. */
  #updateQueueStatus(status: QueueStatus): Effect.Effect<void> {
    return Effect.tryPromise({
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      // Chain off the queue's insert promise so the row exists before any update,
      // preventing the first lifecycle call from racing the insert.
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
      // Observability must not affect execution.
    }
  }
}

function withoutStatus(fields: UpdateRunInput): Omit<UpdateRunInput, "status"> {
  const patch = { ...fields };
  delete patch.status;
  return patch;
}
