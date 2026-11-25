import type { Scope } from "effect";

import {
  Deferred,
  Effect,
  Exit,
  Stream as FxStream,
  Option,
  Scope as ScopeMod,
  SubscriptionRef,
} from "effect";
import { compileWorkflowDefinition } from "./definition/compiler";
import type { WorkflowDefinitionPlan } from "./definition/plan";
import {
  definitionBindingFor,
  definitionMaterializer,
  definitionRuntimeSeed,
  describeWorkflowDefinition,
  WorkflowPlanBuilder,
} from "./definition/plan";
import type {
  DefinitionBinding,
  DefinitionContext,
  DefinitionDescriptor,
  DefinitionGraphBuilder,
  Factory,
} from "./definitions";
import { DefinitionAuthoringError } from "./definitions";
import { errorToShape, resolveInput, runEffectPromise } from "./effect-interop";
import type { ErrorShape } from "./schema";
import type { SuspensionState } from "./slices/channels";
import type { BaseContext } from "./slices/executable";
import { isSuspendSignal } from "./slices/executable";
import type {
  SnapshotState,
  WorkflowSnapshot,
  WorkflowStepNode,
} from "./slices/snapshot";
import type { StepSpec } from "./step";
import { isStepBailError, Step } from "./step";
import type { LogSink, TelemetryLogEntry, TelemetryState } from "./telemetry";
import { noopSink, Telemetry } from "./telemetry";
import type { Bail, RunStatus } from "./types";
import { isBail } from "./types";
import type { WorkflowEffectAccess } from "./workflow-effect-access";
import { workflowEffectAccessKey } from "./workflow-effect-access";

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
  const { children } = step;
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

export type { ErrorShape } from "./schema";

export interface WorkflowPersistence {
  readonly results: "retained" | "transient";
}

export interface WorkflowState {
  readonly attempt: number;
  readonly completedAt?: string;
  readonly createdAt: string;
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

export abstract class Workflow<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> {
  readonly kind = "workflow" as const;

  readonly definitionKey?: string;
  readonly persistence: WorkflowPersistence = { results: "retained" };
  declare readonly name: string;
  readonly description?: string;
  declare __definitionInput?: (input: I) => void;
  declare __definitionOutput?: () => O;
  declare __definitionContext?: (context: X) => void;
  readonly #runtime: WorkflowRuntime<I, O, X> | undefined;
  #definitionPlan: WorkflowDefinitionPlan<I, O, X> | undefined;
  #planningDefinition = false as boolean;
  #auditSink: LogSink = noopSink;
  #observationCallbacks: WorkflowObservationCallbacks | undefined;
  #runId: string | undefined;

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

  protected abstract define(
    graph: DefinitionGraphBuilder<I, O, Record<never, never>, X>
  ): void;

  get definition(): DefinitionDescriptor {
    return describeWorkflowDefinition(this.#plan());
  }

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

  /** @internal */
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

  setAuditSink(sink: LogSink): void {
    this.#auditSink = sink;
  }

  /** @internal */
  setObservationCallbacks(callbacks: WorkflowObservationCallbacks): void {
    this.#observationCallbacks = callbacks;
  }

  setRunId(runId: string): void {
    this.#runId = runId;
  }

  static create<Input, Output, Context extends BaseContext = BaseContext>(
    spec: StepSpec<Input, Output, Context>
  ): Workflow<Input, Output, Context> {
    return Workflow.#allocate<Input, Output, Context>(
      Step.create<Input, Output, Context>(spec),
      spec.input
    );
  }

  static attach<Input, Output, Context extends BaseContext = BaseContext>(
    step: Step<Input, Output, Context>,
    input: Input,
    persistence?: WorkflowPersistence
  ): Workflow<Input, Output, Context> {
    return Workflow.#allocate<Input, Output, Context>(step, input, persistence);
  }

  /** @internal */
  static #allocate<Input, Output, Context extends BaseContext = BaseContext>(
    root: Step<Input, Output, Context>,
    input: Input,
    persistence?: WorkflowPersistence
  ): Workflow<Input, Output, Context> {
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
    const result = Effect.runSync(Deferred.make<WorkflowResult<Output>>());

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

  dispose(): Promise<void> {
    return Effect.runPromise(ScopeMod.close(this.#scope, Exit.void));
  }

  get status(): RunStatus {
    return Effect.runSync(SubscriptionRef.get(this.#status));
  }

  get statusChanges(): ReadableStream<RunStatus> {
    return FxStream.toReadableStream(this.#status.changes);
  }

  get state(): WorkflowState {
    return Effect.runSync(SubscriptionRef.get(this.#state));
  }

  get stateChanges(): ReadableStream<WorkflowState> {
    return FxStream.toReadableStream(this.#state.changes);
  }

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

  /** @internal */
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

  /** @internal */
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
              return err.bail;
            }

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

  /** @internal */
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

  /** @internal */
  [workflowEffectAccessKey](): WorkflowEffectAccess<I, O> {
    return {
      cancel: (reason) => this.#cancel(reason),
      restoreTelemetry: (telemetry) =>
        Effect.sync(() => this.#telemetry.restore(telemetry)).pipe(
          Effect.zipRight(
            SubscriptionRef.update(this.#state, (row) => ({
              ...row,
              telemetry: this.#telemetry.snapshot(),
            }))
          )
        ),
      run: (input, context) => this.#run(input, context),
      state: SubscriptionRef.get(this.#state),
    };
  }
}

class RuntimeWorkflow<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> extends Workflow<I, O, X> {
  protected define(): void {
    throw new Error("Bound runtime Workflows do not define reusable graphs.");
  }
}
