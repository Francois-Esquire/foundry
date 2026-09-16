import type { Schema, Scope } from "effect";

import {
  Deferred,
  Effect,
  Exit,
  Stream as FxStream,
  Option,
  Scope as ScopeMod,
  SubscriptionRef,
} from "effect";

import type { ErrorShapeSchema, SuspensionState } from "./channels";
import { compileWorkflowDefinition } from "./definition-compiler";
import { DefinitionAuthoringError } from "./definition-errors";
import type { WorkflowDefinitionPlan } from "./definition-plan";
import {
  definitionBindingFor,
  definitionMaterializer,
  definitionRuntimeSeed,
  describeWorkflowDefinition,
  WorkflowPlanBuilder,
} from "./definition-plan";
import type {
  DefinitionBinding,
  DefinitionContext,
  DefinitionDescriptor,
  DefinitionGraphBuilder,
} from "./definitions";
import type { BaseContext } from "./executable";
import { isSuspendSignal } from "./executable";
import { errorToShape, resolveInput, runEffectPromise } from "./helpers";
import type { WorkflowEffectAccess } from "./internal/workflow-effect-access";
import { workflowEffectAccessKey } from "./internal/workflow-effect-access";
import type { Factory } from "./orchestrator";
import type {
  SnapshotState,
  WorkflowSnapshot,
  WorkflowStepNode,
} from "./snapshot";
import type { StepSpec } from "./step";
import { isStepBailError, Step } from "./step";
import type { LogSink, TelemetryLogEntry, TelemetryState } from "./telemetry";
import { noopSink, Telemetry } from "./telemetry";
import type { Bail, RunStatus } from "./types";
import { isBail } from "./types";

/**
 * Walk a Step's compositional tree into the {@link WorkflowSnapshot}
 * shape persisted at `metadata.workflow.tree`. The tree is identity-only
 * — `key` is the namespaced path (`a.b.c`), `name` is the local step
 * name, `index` is sibling order. Per-step status lives separately in
 * the flat `metadata.workflow.steps` map keyed by the same `key`.
 *
 * Reading `step.children` lazily binds the step's substrate, so this
 * is safe to call on a freshly-`Step.make`'d root.
 */
export function deriveWorkflowTree<I, O, X extends BaseContext>(
  step: Step<I, O, X>,
  input: unknown
): WorkflowSnapshot {
  return {
    cursor: null,
    input,
    name: step.name,
    steps: [deriveStepNode(step, 0)],
  };
}

function deriveStepNode<I, O, X extends BaseContext>(
  step: Step<I, O, X>,
  index: number
): WorkflowStepNode {
  const children = step.children;
  const node: {
    key: string;
    name: string;
    index: number;
    children?: readonly WorkflowStepNode[];
  } = {
    index,
    key: step.path.join("."),
    name: step.name,
  };
  if (children.length > 0) {
    node.children = children.map((child, i) => deriveStepNode(child, i));
  }
  return node;
}

function pathsEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

/** Plain error data captured at a workflow failure boundary. */
export type ErrorShape = Schema.Schema.Type<typeof ErrorShapeSchema>;

/**
 * Per-Workflow results-persistence policy read by the Queue at the one seam
 * where Run state becomes rows. `retained` (the default) keeps every value;
 * `transient` gates Step outputs, `step.complete` stream values, and the run
 * output out of the persisted row. `materializeLinear` sets `transient`.
 */
export interface WorkflowPersistence {
  readonly results: "retained" | "transient";
}

export interface WorkflowState {
  readonly attempt: number;
  readonly completedAt?: string;
  readonly createdAt: string;
  /**
   * Workflow-level error captured on the `failed` transition. Populated
   * from `workflow.run()`'s catchAll for runtime errors and from the bail
   * handler for `Bail`-typed business failures. Plain-TS shape so JS
   * consumers can read it through `dispatched.error` synchronously.
   */
  readonly error?: ErrorShape;
  readonly input: unknown;
  readonly metadata: Record<string, unknown>;
  readonly output?: unknown;
  readonly startedAt?: string;
  readonly status: RunStatus;
  readonly steps: SnapshotState["steps"];
  readonly suspendedAt?: string;
  readonly suspension?: SuspensionState;
  readonly telemetry: TelemetryState;
  /**
   * Structural workflow plan (`name`, `input`, tree of `WorkflowStepNode`,
   * `cursor`). Mirrored from the underlying `SnapshotState.workflow` so
   * persistence and downstream consumers can read the tree without
   * separately routing the Step's snapshot.
   */
  readonly tree: SnapshotState["workflow"];
}

export interface WorkflowComplete<O> {
  readonly status: "complete";
  readonly value: O;
}

export interface WorkflowFailed {
  readonly error: Error;
  readonly status: "failed";
}

export interface WorkflowCancelled {
  readonly reason?: string;
  readonly status: "cancelled";
}

export type WorkflowResult<O = unknown> =
  | WorkflowComplete<O>
  | WorkflowFailed
  | WorkflowCancelled;

export interface WorkflowObservationCallbacks {
  readonly onLog: (entry: TelemetryLogEntry) => void;
  readonly onProgress: (value: number) => void;
}

/** @internal */
interface WorkflowRuntime<I, O, X extends BaseContext> {
  readonly persistence?: WorkflowPersistence;
  readonly result: Deferred.Deferred<WorkflowResult<O>>;
  readonly root: Step<I, O, X>;
  readonly scope: Scope.CloseableScope;
  readonly state: SubscriptionRef.SubscriptionRef<WorkflowState>;
  readonly status: SubscriptionRef.SubscriptionRef<RunStatus>;
  readonly telemetry: Telemetry;
}

/**
 * Workflow runtime handle. Wraps a {@link Step} and exposes a
 * workflow-centric surface (status, state, result, run) for dispatch
 * and orchestration. Subscriptions are multiplexed into a private lifecycle.
 */
export abstract class Workflow<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> {
  // Discriminator — Orchestrator dispatches Workflow as-is; Step factories
  // get auto-wrapped on resolve.
  readonly kind = "workflow" as const;

  readonly definitionKey?: string;
  /**
   * Results-persistence policy the Queue reads at `#snapshotRunPatch`. A
   * definition subclass overrides this initializer (`materializeLinear` sets
   * `transient`); a bound runtime Workflow inherits its definition's policy
   * through {@link Workflow.attach}. Any Workflow without an explicit policy
   * stays `retained` and encodes as today.
   */
  readonly persistence: WorkflowPersistence = { results: "retained" };
  declare readonly name: string;
  readonly description?: string;
  declare __definitionInput?: (input: I) => void;
  declare __definitionOutput?: () => O;
  declare __definitionContext?: (context: X) => void;
  #runtime: WorkflowRuntime<I, O, X> | undefined;
  #definitionPlan: WorkflowDefinitionPlan<I, O, X> | undefined;
  #planningDefinition = false;
  /**
   * Swappable audit backend. Granular `ctx.log` lines are mirrored here via
   * `record`, and one consolidated audit event is flushed on settle. Defaults
   * to {@link noopSink}; a host swaps in a real sink with {@link setAuditSink}.
   */
  #auditSink: LogSink = noopSink;
  #observationCallbacks: WorkflowObservationCallbacks | undefined;
  /**
   * Durable run id for the audit record. The `Workflow` is built before
   * dispatch, so it has no `rn_...` id of its own; the queue threads the real
   * run id in via {@link setRunId}. Falls back to the root step id (ephemeral)
   * until set — so an unwired sink still gets *an* id, just not the durable one.
   */
  #runId: string | undefined;

  constructor();
  /** @internal */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- separate overload is stripped from the published declaration
  constructor(args: WorkflowRuntime<I, O, X>);
  constructor(args?: WorkflowRuntime<I, O, X>) {
    if (args === undefined) {
      return;
    }
    this.#runtime = args;
    this.name = args.root.name;
    this.persistence = args.persistence ?? { results: "retained" };
    args.root.channels.setLogCallback((entry) => {
      Effect.runFork(this.#appendLog(entry));
      this.#auditSink.record(entry);
      this.#observationCallbacks?.onLog(entry);
    });
    // Channels is shared per Run, so every step's progress lands here — but
    // run-level progress means the root step's progress. Child steps each
    // auto-emit 100 on completion; forwarding those would journal one
    // duplicate progress frame per child.
    args.root.channels.setProgressCallback((value, path) => {
      if (!pathsEqual(path, args.root.path)) {
        return;
      }
      this.#observationCallbacks?.onProgress(value);
    });
  }

  #requireRuntime(): WorkflowRuntime<I, O, X> {
    if (this.#runtime !== undefined) {
      return this.#runtime;
    }
    throw new Error(
      "Definition Workflows have no runtime state; call create(input) first."
    );
  }

  get root(): Step<I, O, X> {
    return this.#requireRuntime().root;
  }

  get #status(): SubscriptionRef.SubscriptionRef<RunStatus> {
    return this.#requireRuntime().status;
  }

  get #state(): SubscriptionRef.SubscriptionRef<WorkflowState> {
    return this.#requireRuntime().state;
  }

  get #result(): Deferred.Deferred<WorkflowResult<O>> {
    return this.#requireRuntime().result;
  }

  get #telemetry(): Telemetry {
    return this.#requireRuntime().telemetry;
  }

  get #scope(): Scope.CloseableScope {
    return this.#requireRuntime().scope;
  }

  /** Public graph declaration; runtime Workflow handles never call it. */
  protected abstract define(
    graph: DefinitionGraphBuilder<I, O, Record<never, never>, X>
  ): void;

  /** Inspectable detached projection of this reusable definition. */
  get definition(): DefinitionDescriptor {
    return describeWorkflowDefinition(this.#plan());
  }

  /** Bind reusable shared context; `.run(input)` materializes fresh runtime. */
  create(context?: DefinitionContext<X>) {
    const source = this;
    return Object.freeze({
      run(input: I, invocationContext?: DefinitionContext<X>): Promise<O> {
        const binding = definitionBindingFor(context, invocationContext);
        const runtime = source.#materialize(input, binding);
        return runtime.run(input, definitionRuntimeSeed(binding));
      },
    });
  }

  #materialize(input: I, binding?: DefinitionBinding<X>): Workflow<I, O, X> {
    const root = this[definitionMaterializer](
      input,
      binding,
      this.#plan().definitionKey
    );
    return Workflow.attach(root, input, this.persistence);
  }

  /** Adapt this reusable definition to the existing Orchestrator contract. */
  factory(): Factory<I, O, X> {
    return (input, execution) => this.#materialize(input, { execution });
  }

  #plan(): WorkflowDefinitionPlan<I, O, X> {
    if (this.#runtime !== undefined) {
      throw new Error(
        "Bound runtime Workflows do not expose a reusable definition."
      );
    }
    if (this.#definitionPlan) {
      return this.#definitionPlan;
    }
    if (!this.definitionKey) {
      throw new Error("Workflow definitions require a definitionKey.");
    }
    if (this.#planningDefinition) {
      throw new DefinitionAuthoringError(
        "definition-cycle",
        this.definitionKey,
        [this.definitionKey],
        "a Workflow definition cannot contain itself recursively"
      );
    }
    this.#planningDefinition = true;
    try {
      const builder = new WorkflowPlanBuilder<I, O, X>(this.definitionKey);
      this.define(builder);
      const name = typeof this.name === "string" ? this.name : undefined;
      this.#definitionPlan = builder.build({
        definitionKey: this.definitionKey,
        ...(name === undefined ? {} : { name }),
        ...(this.description === undefined
          ? {}
          : { description: this.description }),
      });
    } finally {
      this.#planningDefinition = false;
    }
    return this.#definitionPlan;
  }

  /** @internal Compiler protocol; nested Workflows become parent-tree Steps. */
  [definitionMaterializer](
    input: unknown,
    binding: DefinitionBinding | undefined,
    nodeKey: string
  ): Step<I, O, X> {
    return compileWorkflowDefinition(
      this.#plan(),
      input as I,
      binding as DefinitionBinding<X> | undefined,
      (spec) => Step.create(spec),
      nodeKey
    );
  }

  /**
   * Swap in a concrete audit backend (e.g. the evlog wide-event sink). The
   * host owns this seam — this package never configures a global logger.
   */
  setAuditSink(sink: LogSink): void {
    this.#auditSink = sink;
  }

  /** @internal Wire granular progress and log signals to Run observation. */
  setObservationCallbacks(callbacks: WorkflowObservationCallbacks): void {
    this.#observationCallbacks = callbacks;
  }

  /**
   * Set the durable run id stamped on the audit record. The queue calls this
   * at dispatch with the `runs` row id so audit events correlate to the
   * persisted run rather than the ephemeral step id.
   */
  setRunId(runId: string): void {
    this.#runId = runId;
  }

  /**
   * Allocate and return a Workflow from a {@link StepSpec}. Supports
   * immediate `.step()` chaining for child appends.
   */
  static create<I, O, X extends BaseContext = BaseContext>(
    spec: StepSpec<I, O, X>
  ): Workflow<I, O, X> {
    return Workflow.#allocate<I, O, X>(Step.create<I, O, X>(spec), spec.input);
  }

  /**
   * Plain-TS, sync factory. Wraps an existing Step instance — the inner
   * Step IS the workflow's root (snapshot, channels, composer all shared).
   * Use this when the Step tree is built or recovered separately and
   * Workflow is layered on top.
   */
  static attach<I, O, X extends BaseContext = BaseContext>(
    step: Step<I, O, X>,
    input: I,
    persistence?: WorkflowPersistence
  ): Workflow<I, O, X> {
    return Workflow.#allocate<I, O, X>(step, input, persistence);
  }

  /** @internal Allocate Workflow substrate and fork mirror fibers. */
  static #allocate<I, O, X extends BaseContext = BaseContext>(
    root: Step<I, O, X>,
    input: I,
    persistence?: WorkflowPersistence
  ): Workflow<I, O, X> {
    const now = new Date().toISOString();
    const scope = Effect.runSync(ScopeMod.make());
    const status = Effect.runSync(SubscriptionRef.make<RunStatus>("queued"));
    const telemetry = new Telemetry();

    const tree = deriveWorkflowTree(root, input);

    const state = Effect.runSync(
      SubscriptionRef.make<WorkflowState>({
        attempt: 1,
        createdAt: now,
        input,
        metadata: { workflowName: root.name },
        status: "queued",
        steps: {},
        telemetry: telemetry.snapshot(),
        tree,
      })
    );
    const result = Effect.runSync(Deferred.make<WorkflowResult<O>>());

    Effect.runSync(root.snapshot.setWorkflow(tree));

    Effect.runFork(
      FxStream.runForEach(root.snapshot.changes, (snapshotState) =>
        SubscriptionRef.update(state, (row) => ({
          ...row,
          steps: snapshotState.steps,
          tree: snapshotState.workflow,
        }))
      ).pipe(Effect.ensuring(ScopeMod.close(scope, Exit.void)))
    );

    // Status-mirror fiber: propagates #status → #state.status and owns the
    // single `startedAt` write. The `suspendedAt`/`completedAt` timestamps are
    // written synchronously by run()/cancel() (the inline #state updates), so
    // they are NOT derived here — one writer per timestamp, no double-booking.
    Effect.runFork(
      FxStream.runForEach(status.changes, (next) =>
        SubscriptionRef.update(state, (row) => ({
          ...row,
          status: next,
          ...(next === "running" && row.startedAt === undefined
            ? { startedAt: new Date().toISOString() }
            : {}),
        }))
      ).pipe(Effect.ensuring(ScopeMod.close(scope, Exit.void)))
    );

    return new RuntimeWorkflow({
      result,
      root,
      scope,
      state,
      status,
      telemetry,
      ...(persistence === undefined ? {} : { persistence }),
    });
  }

  /**
   * Append a child to the inner root step. Symmetric with
   * {@link Step.step} — accepts either a `StepSpec` (built into a fresh
   * child) or a pre-built `Step` instance (claimed under this workflow's
   * root). Returns `this` so factory chains read like
   * `Workflow.create(spec).step(a).step(b)`.
   *
   * Re-derives the structural workflow tree after every append. The first
   * derive (at construction) only sees the root because `.step()` chains
   * run after; without this re-seed the snapshot's `workflow` and the
   * `#state.tree` would stay frozen with no children, and the queue's
   * synchronous read of `workflow.state` at dispatch time would persist
   * an empty `metadata.workflow.tree`. Both surfaces are updated
   * synchronously so `queue.dispatch` (which runs immediately after the
   * factory returns) sees the populated tree without waiting on the
   * snapshot-mirror fiber.
   */
  step<NewI, NewO, CX extends BaseContext = X>(
    specOrStep: StepSpec<NewI, NewO, CX> | Step<NewI, NewO, CX>
  ): this {
    this.root.step(specOrStep);
    const tree = deriveWorkflowTree(this.root, this.root.input);
    Effect.runSync(this.root.snapshot.setWorkflow(tree));
    Effect.runSync(
      SubscriptionRef.update(this.#state, (row) => ({ ...row, tree }))
    );
    return this;
  }

  /**
   * Tear down the private Scope holding the state-mirror fibers.
   * Idempotent. Standalone callers that build many short-lived Workflows
   * can call this for explicit cleanup; queue/orchestrator-managed
   * Workflows live until process exit, matching {@link Step}'s listener
   * lifetime.
   */
  dispose(): Promise<void> {
    return Effect.runPromise(ScopeMod.close(this.#scope, Exit.void));
  }

  /** Current workflow status. */
  get status(): RunStatus {
    return Effect.runSync(SubscriptionRef.get(this.#status));
  }

  /** Native stream that replays the current status to each subscriber. */
  get statusChanges(): ReadableStream<RunStatus> {
    return FxStream.toReadableStream(this.#status.changes);
  }

  /** Current workflow state snapshot. */
  get state(): WorkflowState {
    return Effect.runSync(SubscriptionRef.get(this.#state));
  }

  /** Native stream that replays the current state to each subscriber. */
  get stateChanges(): ReadableStream<WorkflowState> {
    return FxStream.toReadableStream(this.#state.changes);
  }

  /** Await the first terminal workflow result. */
  result(): Promise<WorkflowResult<O>> {
    return runEffectPromise(Deferred.await(this.#result));
  }

  #incrementMetric(key: string, by = 1): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#telemetry.incrementMetric(key, by);
    }).pipe(
      Effect.flatMap(() =>
        SubscriptionRef.update(this.#state, (row) => ({
          ...row,
          telemetry: this.#telemetry.snapshot(),
        }))
      )
    );
  }

  #appendLog(args: {
    readonly level: "debug" | "info" | "warn" | "error";
    readonly message: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly at?: string;
    readonly stepId?: string;
    readonly path?: readonly string[];
  }): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#telemetry.appendLog(args);
    }).pipe(
      Effect.flatMap(() =>
        SubscriptionRef.update(this.#state, (row) => ({
          ...row,
          telemetry: this.#telemetry.snapshot(),
        }))
      )
    );
  }

  /**
   * Terminal settlement: update `#state` (status + completedAt + any
   * status-specific extra fields) → bump the event + status metrics →
   * mirror `#status` → settle `#result` first-wins. Shared by the
   * failed / bail / complete / cancel transitions. `completedAt` is only
   * written if unset, so it is never double-booked against the
   * status-mirror fiber (which owns `startedAt`).
   *
   * @internal Effect-typed.
   */
  #settle(opts: {
    status: RunStatus;
    eventMetric: string;
    stateExtra?: Partial<WorkflowState>;
    result: WorkflowResult<O>;
  }): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const at = new Date().toISOString();
      yield* SubscriptionRef.update(self.#state, (row) => ({
        ...row,
        completedAt: row.completedAt ?? at,
        status: opts.status,
        ...opts.stateExtra,
      }));
      yield* self.#incrementMetric(opts.eventMetric);
      yield* self.#incrementMetric(`workflow.status.${opts.status}`);
      yield* SubscriptionRef.set(self.#status, opts.status);
      const settled = yield* Deferred.poll(self.#result);
      if (Option.isNone(settled)) {
        yield* Deferred.succeed(self.#result, opts.result);
        // First-win settle: flush exactly one consolidated audit event.
        yield* Effect.sync(() => {
          self.#auditSink.settle({
            at,
            runId: self.#runId ?? self.root.id,
            status: opts.status,
          });
        });
      }
    });
  }

  /**
   * Drive the workflow. Bail-tagged values are returned as-is; throws
   * or returns suspension signals; success returns the output.
   *
   * @internal Effect-typed. Returns `O | Bail<unknown>`.
   */
  #run(
    input?: I,
    ctxExtension?: object
  ): Effect.Effect<O | Bail<unknown>, Error> {
    const self = this;
    return Effect.gen(function* () {
      const nextInput = resolveInput(input, self.root.input);
      yield* SubscriptionRef.update(self.#state, (row) => ({
        ...row,
        input: nextInput,
      }));
      yield* self.#incrementMetric("workflow.runs");
      yield* self.#incrementMetric("workflow.status.running");
      yield* SubscriptionRef.set(self.#status, "running");

      const result: O | Bail<unknown> = yield* Effect.tryPromise({
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        try: () => self.root.run(nextInput, ctxExtension),
      }).pipe(
        Effect.catchAll((err) =>
          Effect.gen(function* () {
            if (isSuspendSignal(err)) {
              const at = new Date().toISOString();
              yield* SubscriptionRef.update(self.#state, (row) => ({
                ...row,
                status: "suspended" as const,
                suspendedAt: at,
                suspension: err.suspension,
              }));
              yield* self.#incrementMetric("workflow.suspensions");
              yield* self.#incrementMetric("workflow.status.suspended");
              yield* SubscriptionRef.set(self.#status, "suspended");
              return yield* Effect.fail(err);
            }

            if (isStepBailError(err)) {
              // Re-surface the captured Bail value through the success
              // channel — the bail-tagged downstream branch below handles
              // status/metrics/Deferred settlement.
              return err.bail;
            }

            // If the workflow was cancelled mid-flight, the step's
            // abort signal is what surfaced this error — preserve the
            // cancelled status set by `cancel()` rather than overwriting
            // it with `failed`. The result deferred already holds the
            // cancelled outcome (Deferred is first-wins).
            const currentStatus = yield* SubscriptionRef.get(self.#status);
            if (currentStatus === "cancelled") {
              return yield* Effect.fail(err);
            }
            yield* self.#settle({
              eventMetric: "workflow.failures",
              result: { error: err, status: "failed" },
              stateExtra: { error: errorToShape(err) },
              status: "failed",
            });
            return yield* Effect.fail(err);
          })
        )
      );

      // Bail-tagged result — handle status/metrics/Deferred and surface
      // the Bail to the caller.
      if (typeof result === "object" && result !== null && "_bail" in result) {
        const bail = result;
        const bailError = new Error(
          `Workflow "${self.name}" bailed: ${JSON.stringify(bail.error)}`
        );
        yield* self.#settle({
          eventMetric: "workflow.bails",
          result: { error: bailError, status: "failed" },
          stateExtra: { error: errorToShape(bailError) },
          status: "failed",
        });
        return bail;
      }

      yield* self.#settle({
        eventMetric: "workflow.completions",
        result: { status: "complete", value: result },
        stateExtra: { output: result },
        status: "complete",
      });
      return result;
    });
  }

  /**
   * Plain-JS convenience: drive this workflow and resolve with `O`.
   * Throws on bail or runtime error. Routes through {@link run} (not the
   * inner Step) so the Workflow handle — status/state/result — settles
   * correctly; the bail-tagged value is re-thrown to preserve the
   * throw-on-bail contract.
   */
  run(input?: I, ctxExtension?: object): Promise<O> {
    if (this.#runtime === undefined) {
      return this.create().run(input as I, ctxExtension);
    }
    return runEffectPromise(
      this.#run(input, ctxExtension).pipe(
        Effect.flatMap((out) =>
          isBail(out)
            ? Effect.fail(
                new Error(
                  `Workflow "${this.name}" bailed: ${JSON.stringify(out.error)}`
                )
              )
            : Effect.succeed(out)
        )
      )
    );
  }

  abort(reason?: unknown): void {
    this.root.abort(reason);
  }

  #cancel(reason?: string): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      self.root.abort(reason);
      yield* self.#settle({
        eventMetric: "workflow.cancellations",
        result: {
          status: "cancelled",
          ...(reason === undefined ? {} : { reason }),
        },
        status: "cancelled",
      });
    });
  }

  cancel(reason?: string): Promise<void> {
    return runEffectPromise(this.#cancel(reason));
  }

  #resolve(name: string, value: unknown): Effect.Effect<void> {
    return Effect.promise(() => this.root.resolve(name, value));
  }

  resolve(name: string, value: unknown): Promise<void> {
    return runEffectPromise(this.#resolve(name, value));
  }

  #resolveOccurrence(
    stepPath: readonly string[],
    name: string,
    occurrence: number,
    value: unknown
  ): Effect.Effect<void> {
    return Effect.promise(() =>
      this.root.resolveOccurrence(stepPath, name, occurrence, value)
    );
  }

  resolveOccurrence(
    stepPath: readonly string[],
    name: string,
    occurrence: number,
    value: unknown
  ): Promise<void> {
    return runEffectPromise(
      this.#resolveOccurrence(stepPath, name, occurrence, value)
    );
  }

  #resume(name: string, value: unknown): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.#resolve(name, value);
      yield* SubscriptionRef.set(self.#status, "queued");
      yield* SubscriptionRef.update(self.#state, (row) => ({
        ...row,
        status: "queued" as const,
      }));
    });
  }

  resume(name: string, value: unknown): Promise<void> {
    return runEffectPromise(this.#resume(name, value));
  }

  #resumeOccurrence(
    stepPath: readonly string[],
    name: string,
    occurrence: number,
    value: unknown
  ): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.#resolveOccurrence(stepPath, name, occurrence, value);
      yield* SubscriptionRef.set(self.#status, "queued");
      yield* SubscriptionRef.update(self.#state, (row) => ({
        ...row,
        status: "queued" as const,
      }));
    });
  }

  resumeOccurrence(
    stepPath: readonly string[],
    name: string,
    occurrence: number,
    value: unknown
  ): Promise<void> {
    return runEffectPromise(
      this.#resumeOccurrence(stepPath, name, occurrence, value)
    );
  }

  /**
   * Restore workflow state from persisted metadata (used on hydrate).
   * Merges supplied partial onto existing state so fresh fields survive.
   *
   * @internal
   */
  #seedState(
    persisted: Partial<WorkflowState> & { status: RunStatus }
  ): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      yield* SubscriptionRef.set(self.#status, persisted.status);
      yield* SubscriptionRef.update(self.#state, (row) => ({
        ...row,
        ...persisted,
      }));
    });
  }

  seedState(
    persisted: Partial<WorkflowState> & { status: RunStatus }
  ): Promise<void> {
    return runEffectPromise(this.#seedState(persisted));
  }

  /** @internal Package-private Effect adapter; stripped from declarations. */
  [workflowEffectAccessKey](): WorkflowEffectAccess<I, O> {
    return {
      cancel: (reason) => this.#cancel(reason),
      resolve: (name, value) => this.#resolve(name, value),
      resolveOccurrence: (path, name, occurrence, value) =>
        this.#resolveOccurrence(path, name, occurrence, value),
      result: Deferred.await(this.#result),
      resume: (name, value) => this.#resume(name, value),
      resumeOccurrence: (path, name, occurrence, value) =>
        this.#resumeOccurrence(path, name, occurrence, value),
      run: (input, context) => this.#run(input, context),
      seedState: (state) => this.#seedState(state),
      state: SubscriptionRef.get(this.#state),
      stateChanges: this.#state.changes,
      status: SubscriptionRef.get(this.#status),
      statusChanges: this.#status.changes,
    };
  }
}

/** Bound runtime implementation behind legacy `Workflow.create(spec)`. */
class RuntimeWorkflow<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> extends Workflow<I, O, X> {
  protected define(): void {
    throw new Error("Bound runtime Workflows do not define reusable graphs.");
  }
}
