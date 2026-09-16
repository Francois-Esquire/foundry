import { Effect, Exit, Scope, Stream } from "effect";

import type {
  ChannelMessage,
  Channels,
  ChunkPayload,
  SuspensionRequest,
} from "./channels";
import { Channels as ChannelsClass } from "./channels";
import { Composer } from "./composer";
import type { LeafDefinitionPlan } from "./definition-plan";
import {
  createLeafDefinitionPlan,
  definitionBindingFor,
  definitionMaterializer,
  definitionRuntimeOptions,
  definitionRuntimeSeed,
  describeLeafDefinition,
} from "./definition-plan";
import type {
  DefinitionBinding,
  DefinitionContext,
  DefinitionDescriptor,
} from "./definitions";
import type { BaseContext, Executable, ExecutableConfig } from "./executable";
import { Executable as ExecutableClass } from "./executable";
import { runEffectPromise } from "./helpers";
import type { Factory } from "./orchestrator";
import type {
  SnapshotState,
  StepSnapshot,
  StepStatus,
  WorkflowSnapshot,
} from "./snapshot";
import { Snapshot } from "./snapshot";
import type { StepContext, StepSpec } from "./step-types";
import type { Bail, Unsubscribe } from "./types";
// StepBailError / isStepBailError live in `./types` — re-exported here for
// back-compat with consumers that import from "@foundry/workflows/step".
import { isBail, isStepBailError, StepBailError } from "./types";

// StepContext / StepSpec live in `./step-types` — re-exported here so
// consumers that import from "@foundry/workflows/step" keep resolving them.
export type { StepContext, StepSpec };
export { isStepBailError, StepBailError };

function optionalMetadata(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface StepRuntime<I, X extends BaseContext> {
  readonly config: Partial<ExecutableConfig> | undefined;
  readonly id: string;
  readonly input: I;
  readonly name: string;
  readonly pendingChildren: (StepSpec | Step)[];
  readonly seed: Omit<X, "name"> | undefined;
}

/**
 * Step execution primitive. Every Step has an `execute` function that
 * receives `input` and `ctx` ({@link StepContext}). Children declared in
 * `spec.children` or forked via `ctx.fork` are auto-draining in the
 * post-body cascade. `execute` may be an async function returning
 * `Promise<O | Bail>` or an async generator yielding chunks (routed
 * through `ctx.write`) and returning output. A body may opt into
 * Koa-style `await ctx.next()` to drain children with failure
 * propagation; bodies that skip it get fire-and-forget draining.
 *
 * Step owns four slices: {@link Snapshot} (tree state; shared per Run),
 * {@link Channels} (broadcast hub; shared per Run), {@link Executable}
 * (per-frame execution and cancellation), and {@link Composer}
 * (tree-walking). Substrate is lazy — allocated on first access (or
 * at `step.run()` time if not accessed earlier).
 *
 * For public-consumer API semantics, see {@link Step.run} and
 * {@link Step.runPromise}. For reactive streams, see {@link statusChanges},
 * {@link outputChanges}, {@link stream}, {@link changes}.
 */
export abstract class Step<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> {
  // ── Identity ─────────────────────────────────────────────────────────────

  /**
   * Stable id for this step instance. Set via `spec.id` or auto-generated;
   * preserved across the lifetime. Distinguishes siblings with the same name.
   */
  // Discriminator — Orchestrator uses this after factory resolution to
  // decide whether to wrap a returned Step in a Workflow before dispatch.
  readonly kind = "step" as const;

  // ── User-provided ────────────────────────────────────────────────────────

  /**
   * The body function. Two shapes:
   *
   *   - **Async function**: `(input, ctx) => Promise<O | Bail<unknown>>`
   *   - **Async generator**: `async function* (input, ctx) { yield x; return result }`
   *
   * In both cases, the typed context `ctx` ({@link StepContext}) provides
   * access to `step`, `path`, `children`, `fork`, `next()`, `write()`, and
   * composition primitives like `invoke()`, `parallel()`, `race()`, etc.
   * {@link StepContext} also spreads the seed context type `X`.
   *
   * Generator yields are routed through {@link write} (string → text,
   * `undefined`/`null` → no-op, else → data chunk). The generator's `return`
   * value becomes the step's output.
   */
  readonly definitionKey?: string;
  declare readonly name: string;
  readonly description?: string;
  declare __definitionInput?: (input: I) => void;
  declare __definitionOutput?: () => O;
  declare __definitionContext?: (context: X) => void;

  /** Author-defined leaf behavior; runtime subclasses keep it private. */
  protected abstract execute(
    input: I,
    ctx: StepContext<I, O, X>
  ):
    | Promise<O | Bail<unknown>>
    | AsyncGenerator<unknown, O | Bail<unknown>, unknown>;

  /**
   * Backing field for the public `children` getter. Populated during
   * `#initialize` from `spec.children` and appended to at runtime via `ctx.fork`.
   */
  readonly #children: Step[] = [];

  // ── Deferred-spec stash ──────────────────────────────────────────────────
  // The constructor stores spec inputs; `#initialize` performs allocation.

  #runtime: StepRuntime<I, X> | undefined;
  #definitionPlan: LeafDefinitionPlan<I, O, X> | undefined;

  /**
   * True when this Step is stashed into a parent's `#pendingChildren`.
   * A claimed step refuses substrate access until the parent binds it;
   * an unclaimed step auto-binds as a root on first access.
   */
  #claimedByParent = false;

  // ── Substrate (lazy) ─────────────────────────────────────────────────────
  // Effect-allocated state; undefined until `#initialize`. Public getters route
  // through `#s`, which triggers lazy bind or throws "not bound" if claimed.

  #substrate?: {
    readonly snapshot: Snapshot;
    readonly channels: Channels;
    readonly composer: Composer;
    readonly executable: Executable<I, X>;
    readonly scope: Scope.CloseableScope;
  };

  #requireRuntime(): StepRuntime<I, X> {
    if (this.#runtime !== undefined) {
      return this.#runtime;
    }
    throw new Error(
      "Definition Steps have no runtime state; call create(input) first."
    );
  }

  get #specName(): string {
    return this.#requireRuntime().name;
  }

  get #specInput(): I {
    return this.#requireRuntime().input;
  }

  get #specSeed(): Omit<X, "name"> | undefined {
    return this.#requireRuntime().seed;
  }

  get #specConfig(): Partial<ExecutableConfig> | undefined {
    return this.#requireRuntime().config;
  }

  get #pendingChildren(): (StepSpec | Step)[] {
    return this.#requireRuntime().pendingChildren;
  }

  /**
   * Single seam for substrate access. Throws "not bound" if the Step is
   * claimed-but-unbound; auto-binds as a root if unclaimed-unbound.
   */
  get #s() {
    if (this.#runtime === undefined) {
      throw new Error(
        "Definition Steps have no runtime substrate; call create(input) first."
      );
    }
    if (this.#substrate) {
      return this.#substrate;
    }
    if (this.#claimedByParent) {
      throw new Error(
        `Step "${this.#specName}" is not bound — its parent hasn't initialized yet; bind by running the parent or wait until parent.run()`
      );
    }
    this.#initialize(null);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.#substrate!;
  }

  constructor(args?: { spec: StepSpec<I, O, X> }) {
    const spec = args?.spec;
    if (spec === undefined) {
      return;
    }
    this.#runtime = {
      config: spec.config,
      id: spec.id ?? `${spec.name}_${Math.random().toString(36).slice(2, 6)}`,
      input: spec.input,
      name: spec.name,
      pendingChildren: [...(spec.children ?? [])],
      seed: spec.seed,
    };
    // Mark Step-instance children as claimed so any substrate access
    // before this parent initializes throws (rather than self-binding
    // as a root that would conflict with the parent's eventual fork).
    for (const childOrSpec of this.#pendingChildren) {
      if (childOrSpec instanceof Step) {
        if (childOrSpec.#substrate || childOrSpec.#claimedByParent) {
          throw new Error(`Step "${childOrSpec.#specName}" is already bound`);
        }
        childOrSpec.#claimedByParent = true;
      }
    }
    // ID derives from the spec name in pass-3 (no executable yet at
    // construction time). The behavior is equivalent — pre-pass-3
    // `args.executable.name` was always seeded from `spec.name`.
    this.name = spec.name;
  }

  /** Stable id of a bound runtime Step. Definitions deliberately have none. */
  get id(): string {
    if (this.#runtime === undefined) {
      throw new Error(
        "Definition Steps do not have a runtime id; call create(input) first."
      );
    }
    return this.#runtime.id;
  }

  /** Inspectable detached projection of this reusable definition. */
  get definition(): DefinitionDescriptor {
    return describeLeafDefinition(this.#plan());
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

  #materialize(input: I, binding?: DefinitionBinding<X>): Step<I, O, X> {
    return this[definitionMaterializer](
      input,
      binding,
      this.#plan().definitionKey
    );
  }

  /** Adapt this reusable definition to the existing Orchestrator contract. */
  factory(): Factory<I, O, X> {
    return (input, execution) => this.#materialize(input, { execution });
  }

  #plan(): LeafDefinitionPlan<I, O, X> {
    if (this.#runtime !== undefined) {
      throw new Error(
        "Bound runtime Steps do not expose a reusable definition."
      );
    }
    if (this.#definitionPlan) {
      return this.#definitionPlan;
    }
    if (!this.definitionKey) {
      throw new Error("Step definitions require a definitionKey.");
    }
    const name = optionalMetadata(this.name);
    const plan = createLeafDefinitionPlan({
      definitionKey: this.definitionKey,
      kind: "step",
      ...(name === undefined ? {} : { name }),
      ...(this.description === undefined
        ? {}
        : { description: this.description }),
      execute: this.execute.bind(this),
    });
    this.#definitionPlan = plan;
    return plan;
  }

  /** @internal Compiler protocol; materializes a fresh placed runtime Step. */
  [definitionMaterializer](
    input: unknown,
    binding: DefinitionBinding | undefined,
    nodeKey: string
  ): Step<I, O, X> {
    const plan = this.#plan();
    return Step.create<I, O, X>({
      input: input as I,
      name: nodeKey,
      ...definitionRuntimeOptions(binding as DefinitionBinding<X> | undefined),
      execute: (nextInput, context) => plan.execute(nextInput, context),
    });
  }

  // ── Initialization ───────────────────────────────────────────────────────

  /**
   * @internal Allocate the substrate.
   *
   *   - Root path (`parent === null`): allocate fresh Scope and all slices.
   *   - Child path (`parent !== null`): fork parent's snapshot/channels
   *     (shared per Run), fork composer (forks executable), share scope.
   *
   * Then walk `#pendingChildren`: materialize StepSpec children and
   * recursively bind Step instances.
   *
   * Throws if already bound.
   */
  #initialize(parent: Step | null): void {
    if (this.#substrate) {
      throw new Error(`Step "${this.#specName}" is already bound`);
    }

    const self = this;
    const built =
      parent === null
        ? Effect.runSync(
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              const slices = yield* Effect.gen(function* () {
                const snapshot = yield* Snapshot.make();
                const channels = yield* ChannelsClass.make(snapshot);
                const executable = yield* ExecutableClass.make<I, X>({
                  input: self.#specInput,
                  name: self.#specName,
                  ...(self.#specSeed === undefined
                    ? {}
                    : { seed: self.#specSeed }),
                  ...(self.#specConfig === undefined
                    ? {}
                    : { config: self.#specConfig }),
                });
                const composer = Composer.root({ channels }, executable);
                return { channels, composer, executable, snapshot };
              }).pipe(Scope.extend(scope));
              return { ...slices, scope };
            })
          )
        : (() => {
            const parentS = parent.#s;
            // Child path — share parent's snapshot/channels (fork() returns
            // `this` for those slices); fork composer (which forks
            // executable). Scope is shared so dispose() reaps the tree.
            const snapshot = parentS.snapshot.fork();
            const channels = parentS.channels.fork();
            const composer = parentS.composer.fork(
              self.#specName,
              self.#specInput,
              self.#specConfig
            );
            return {
              channels,
              composer,
              executable: composer.executable as unknown as Executable<I, X>,
              scope: parentS.scope,
              snapshot,
            };
          })();

    this.#substrate = {
      channels: built.channels,
      composer: built.composer,
      executable: built.executable,
      scope: built.scope,
      snapshot: built.snapshot,
    };

    // Materialize declared children. Specs become fresh Step instances
    // bound under this substrate; pre-built Step instances get
    // recursively bound via `child.#initialize(this)`.
    for (const childOrSpec of this.#pendingChildren) {
      if (childOrSpec instanceof Step) {
        childOrSpec.#initialize(this as unknown as Step);
        this.#children.push(childOrSpec);
      } else {
        const child = this.#materializeSpecChild(childOrSpec);
        this.#children.push(child);
      }
    }
  }

  /**
   * @internal Construct an unbound Step. Routes all construction through
   * one site so the protected constructor needn't be reached via a cast.
   */
  static #new<I, O, X extends BaseContext = BaseContext>(
    spec: StepSpec<I, O, X>
  ): Step<I, O, X> {
    return new RuntimeStep<I, O, X>(spec);
  }

  /**
   * @internal Materialize a child Step from a spec under this Step's substrate.
   */
  #materializeSpecChild(spec: StepSpec): Step {
    const child = Step.#new(spec);
    child.#initialize(this as unknown as Step);
    return child;
  }

  // ── Allocation ───────────────────────────────────────────────────────────

  /**
   * Allocate a Step synchronously (unbound — no substrate yet).
   * Substrate is acquired by passing into a parent's `spec.children`,
   * calling `.step(...)`, or calling `.run()`.
   *
   * @example
   *   const parent = Step.create({ name, input, execute }).step(childSpec);
   */
  static create<I, O, X extends BaseContext = BaseContext>(
    spec: StepSpec<I, O, X>
  ): Step<I, O, X> {
    return Step.#new(spec);
  }

  /**
   * Allocate a Step asynchronously. Wraps {@link Step.create} for
   * back-compat with code that does `await Step.make(...)`.
   */
  static make<I, O, X extends BaseContext = BaseContext>(
    spec: StepSpec<I, O, X>
  ): Promise<Step<I, O, X>> {
    return Promise.resolve(Step.create<I, O, X>(spec));
  }

  /**
   * Allocate a Step with no input. Sugar for steps with no children.
   *
   * @example
   *   const step = await Step.from("hello", async () => "world");
   *   const value = await step.run(); // "world"
   */
  static from<O = unknown>(
    name: string,
    body: () => Promise<O | Bail<unknown>>
  ): Promise<Step<void, O>> {
    return Step.make<void, O>({
      execute: () => body(),
      input: undefined,
      name,
    });
  }

  /**
   * Tear down this Step's substrates. Idempotent; no-op if unbound.
   */
  dispose(): Promise<void> {
    if (!this.#substrate) {
      return Promise.resolve();
    }
    return Effect.runPromise(Scope.close(this.#substrate.scope, Exit.void));
  }

  // ── Slice accessors (route through #s) ───────────────────────────────────

  /**
   * Children of this Step — declared (from `spec.children`) and
   * dynamically forked (via `ctx.fork`). Reading triggers lazy bind.
   */
  get children(): readonly Step[] {
    // Touch substrate to trigger lazy bind / materialize declared children.
    this.#s; // eslint-disable-line @typescript-eslint/no-unused-expressions
    return this.#children;
  }

  /** @internal Runtime projection; omitted from the published declaration. */
  get snapshot(): Snapshot {
    return this.#s.snapshot;
  }
  /** @internal Runtime event substrate; omitted from the published declaration. */
  get channels(): Channels {
    return this.#s.channels;
  }
  /** Ordered messages for this run. Shared by its steps; only one reader may hold the stream lock. */
  get channelStream(): ReadableStream<ChannelMessage> {
    return this.#s.channels.stream;
  }
  /** @internal Effect execution substrate; omitted from the published declaration. */
  get executable(): Executable<I, X> {
    return this.#s.executable;
  }
  /** @internal Effect composition substrate; omitted from the published declaration. */
  get composer(): Composer {
    return this.#s.composer;
  }

  /**
   * Create and register a dynamic child Step. The child shares parent
   * substrate and inherits the typed context `X`.
   */
  fork<NewI, NewO>(spec: StepSpec<NewI, NewO, X>): Step<NewI, NewO, X> {
    const child = this.#materializeSpecChild(
      spec as unknown as StepSpec
    ) as unknown as Step<NewI, NewO, X>;
    this.#children.push(child as unknown as Step);
    return child;
  }

  /**
   * Append a child (pre-bind or post-bind). Returns `this` for chaining.
   * Throws if the Step is already bound or claimed.
   *
   * Pre-bind: stash into `#pendingChildren` for `#initialize` to walk.
   * Post-bind: fork (for spec) or bind and append (for Step).
   *
   * The child's context `CX` defaults to this Step's `X` but may be any
   * `BaseContext` — a child that declares a *narrower* context (e.g. a
   * plain `BaseContext` step) composes under a richer parent, since the
   * parent seeds at least what the child reads (the child's frame
   * receives the parent's context via `fork`). This is the
   * supertype-relaxed direction; it lets a `FoundryContext` workflow host
   * library `BaseContext` steps without erasing the parent's own typing.
   *
   * @example
   *   const parent = Step.create(parentSpec)
   *     .step(childOneSpec)
   *     .step(childTwoSpec);
   *   await parent.run();
   */
  step<NewI, NewO, CX extends BaseContext = X>(
    specOrStep: StepSpec<NewI, NewO, CX> | Step<NewI, NewO, CX>
  ): this {
    const isStep = specOrStep instanceof Step;
    if (this.#substrate) {
      // Post-bind path — the live substrate is set, so append under it.
      if (isStep) {
        const child = specOrStep;
        if (child.#substrate || child.#claimedByParent) {
          throw new Error(
            `Step "${child.#specName}" is already bound or claimed by another parent`
          );
        }
        child.#claimedByParent = true;
        child.#initialize(this as unknown as Step);
        this.#children.push(child as unknown as Step);
        return this;
      }
      // CX may be narrower than X; the runtime fork seeds the parent's
      // full context, so the child receives at least what it declares.
      this.fork(specOrStep as unknown as StepSpec<NewI, NewO, X>);
      return this;
    }
    // Pre-bind path — stash into pending children for #initialize to walk.
    if (isStep) {
      const child = specOrStep;
      if (child.#substrate || child.#claimedByParent) {
        throw new Error(
          `Step "${child.#specName}" is already bound or claimed by another parent`
        );
      }
      child.#claimedByParent = true;
      this.#pendingChildren.push(child as unknown as Step);
      return this;
    }
    const child = Step.create<NewI, NewO, CX>(specOrStep);
    child.#claimedByParent = true;
    this.#pendingChildren.push(child as unknown as Step);
    return this;
  }

  // ── Per-frame readers ────────────────────────────────────────────────────

  get input(): I {
    return this.executable.input;
  }
  get path(): readonly string[] {
    return this.executable.path;
  }
  get context(): X {
    return this.executable.context;
  }
  get config(): ExecutableConfig {
    return this.executable.config;
  }

  // ── Status (driven by channel-event subscriber) ──────────────────────────

  /**
   * Current lifecycle status of this step. Read off the synchronously
   * projected snapshot. One of: `pending`, `running`, `complete`,
   * `failed`, `suspended`, `paused`, `skipped`, `aborted`.
   */
  get status(): StepStatus {
    const state = Effect.runSync(this.snapshot.current);
    const key = this.path.join(".");
    return state.steps[key]?.status ?? "pending";
  }

  /**
   * @internal Effect-Stream form of status transitions. Use the JS twin
   * {@link statusChanges} (ReadableStream) on the consumer surface.
   */
  get #statusChanges(): Stream.Stream<StepStatus> {
    const key = this.path.join(".");
    return this.snapshot.stepsChanges.pipe(
      Stream.map((steps) => steps[key]?.status ?? "pending"),
      Stream.changes
    );
  }

  /** Native ReadableStream of status transitions for plain-JS consumers. */
  get statusChanges(): ReadableStream<StepStatus> {
    return Stream.toReadableStream(this.#statusChanges);
  }

  /**
   * Output from the most recent successful run, or `undefined` if not
   * yet complete. Read off the synchronously projected snapshot.
   */
  get output(): O | undefined {
    const state = Effect.runSync(this.snapshot.current);
    const key = this.path.join(".");
    return state.steps[key]?.output as O | undefined;
  }

  /**
   * @internal Effect-Stream of completion outputs for this step's path.
   */
  get #outputChanges(): Stream.Stream<O> {
    return this.channels.outputFor<O>(this.path);
  }

  /** Reactive native stream of completion outputs. */
  get outputChanges(): ReadableStream<O> {
    return Stream.toReadableStream(this.#outputChanges);
  }

  /**
   * True when status is `complete`, `failed`, `aborted`, or `skipped`.
   */
  get isTerminal(): boolean {
    const s = this.status;
    return (
      s === "complete" || s === "failed" || s === "aborted" || s === "skipped"
    );
  }

  /**
   * True when status is `"paused"`.
   */
  get paused(): boolean {
    return this.status === "paused";
  }

  // ── Progress ─────────────────────────────────────────────────────────────

  /**
   * Current progress in [0, 100]. Defaults to 0; completion auto-emits 100.
   */
  get progress(): number {
    const state = Effect.runSync(this.snapshot.current);
    const key = this.path.join(".");
    return state.steps[key]?.progress ?? 0;
  }

  /**
   * Set progress. Throws RangeError if out of [0, 100] or NaN.
   * Idempotent past terminal.
   */
  set progress(value: number) {
    if (this.isTerminal) {
      return;
    }
    if (
      typeof value !== "number" ||
      Number.isNaN(value) ||
      value < 0 ||
      value > 100
    ) {
      throw new RangeError(
        `step.progress must be in [0, 100], got ${String(value)}`
      );
    }
    this.#publishProgress(value);
  }

  /** @internal Effect-Stream of progress values. */
  get #progressChanges(): Stream.Stream<number> {
    return this.channels.progressFor(this.path);
  }

  /** Reactive native stream of progress values. */
  get progressChanges(): ReadableStream<number> {
    return Stream.toReadableStream(this.#progressChanges);
  }

  /** Push a `step.progress` event tagged with the current attempt. */
  #publishProgress(value: number): void {
    this.channels.progress(
      this.path,
      this.name,
      this.#attemptFromSnapshot(),
      value
    );
  }

  // ── Cancellation (delegated) ─────────────────────────────────────────────

  /** True if abort signal has fired. */
  get aborted(): boolean {
    return this.executable.aborted;
  }
  /** Abort reason, if set. */
  get reason(): unknown {
    return this.executable.reason;
  }

  /** AbortSignal for this step. */
  get signal(): AbortSignal {
    return this.executable.signal;
  }

  /**
   * Request cancellation. Idempotent on terminal steps.
   */
  abort(reason?: unknown): void {
    // Emit step.aborted only when the step is still cancellable.
    // executable.abort() always fires for substrate-sharing children.
    if (!this.isTerminal && this.status !== "aborted") {
      this.channels.aborted(
        this.path,
        this.name,
        this.#attemptFromSnapshot(),
        reason
      );
    }
    this.executable.abort(reason);
  }
  /** Register a callback to fire when abort is requested. */
  onAbort(handler: (reason: unknown) => void): Unsubscribe {
    return this.executable.onAbort(handler);
  }

  // ── Suspension (delegated) ───────────────────────────────────────────────

  /**
   * @internal Effect-typed suspend.
   */
  #suspend<T>(
    args: SuspensionRequest,
    occurrence?: number
  ): Effect.Effect<T, Error> {
    return this.executable.suspend<T>(args, occurrence);
  }

  /**
   * Suspend until a matching {@link resolve} is delivered.
   */
  suspend<T>(args: SuspensionRequest, occurrence?: number): Promise<T> {
    return runEffectPromise(this.#suspend<T>(args, occurrence));
  }

  /**
   * @internal Effect-typed resolve.
   */
  #resolve(name: string, value: unknown): Effect.Effect<void> {
    return this.executable.resolve(name, value);
  }

  /**
   * Deliver a resolution for the suspension with the given name.
   */
  resolve(name: string, value: unknown): Promise<void> {
    return runEffectPromise(this.#resolve(name, value));
  }

  /** @internal Resolve one deterministic suspension occurrence. */
  resolveOccurrence(
    stepPath: readonly string[],
    name: string,
    occurrence: number,
    value: unknown
  ): Promise<void> {
    return runEffectPromise(
      this.executable.resolveOccurrence(stepPath, name, occurrence, value)
    );
  }

  // ── Pause / resume / skip ────────────────────────────────────────────────

  /**
   * Pause this step. Idempotent; no-op on terminal steps.
   * Fires a `step.paused` event; next pause-check parks execution.
   */
  pause(reason?: string): void {
    if (this.isTerminal || this.paused) {
      return;
    }
    this.channels.paused(
      this.path,
      this.name,
      this.#attemptFromSnapshot(),
      reason
    );
  }

  /**
   * Resume a paused step. No-op if not paused.
   */
  resume(): void {
    if (!this.paused) {
      return;
    }
    this.channels.resumed(this.path, this.name, this.#attemptFromSnapshot());
  }

  /**
   * Skip this step. Pre-execution only; throws if step is running or terminal.
   */
  skip(reason?: string): void {
    const s = this.status;
    if (s !== "pending") {
      throw new Error(
        `step.skip(): can only skip a pending step (current status: "${s}")`
      );
    }
    this.channels.skipped(this.path, this.name, 0, reason);
  }

  /**
   * Pause-check for use inside an execute body.
   * Resolves immediately if not paused; parks if paused.
   */
  waitIfPaused(): Promise<void> {
    return runEffectPromise(this.#waitWhilePaused());
  }

  /**
   * @internal Effect-typed pause gate. Reads the snapshot-derived status
   * stream ({@link #statusChanges}); since the underlying SubscriptionRef
   * replays its current value on subscribe, this both observes the current
   * status and waits for the next non-paused transition in one filtered
   * take — no separate "read current then subscribe" race window.
   */
  #waitWhilePaused(): Effect.Effect<void> {
    return this.#statusChanges.pipe(
      Stream.filter((s) => s !== "paused"),
      Stream.take(1),
      Stream.runDrain
    );
  }

  /**
   * @internal Read the attempt number from the snapshot.
   */
  #attemptFromSnapshot(): number {
    const state = Effect.runSync(this.snapshot.current);
    const key = this.path.join(".");
    return state.steps[key]?.attempt ?? 0;
  }

  // ── Channel helpers ──────────────────────────────────────────────────────

  /** Publish a custom event under this frame's path. */
  emit(type: string, payload?: unknown): void {
    this.channels.custom(type, this.name, this.path, payload);
  }

  /**
   * Emit a granular, path-scoped log line from this step's body. Routes
   * through the run-level log callback the Workflow installed on Channels —
   * landing in the run's telemetry ring + live state and the swappable
   * audit sink. Inert (no-op) until a Workflow wires the callback.
   */
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>
  ): void {
    this.#s.channels.emitLog({
      at: new Date().toISOString(),
      level,
      message,
      path: this.path,
      stepId: this.id,
      ...(fields === undefined ? {} : { metadata: fields }),
    });
  }

  /**
   * ReadableStream of chunks this step has published.
   * Subscription closes automatically on abort.
   */
  get stream(): ReadableStream<ChunkPayload> {
    return this.channels.chunksFor(this.name, this.signal);
  }

  /**
   * Push a chunk into this step's stream.
   *
   *   - `undefined` / `null`: no-op.
   *   - `string`: text chunk.
   *   - else: data chunk (must be JSON-serializable).
   */
  write(value: unknown): void {
    if (value === undefined || value === null) {
      return;
    }
    if (typeof value === "string") {
      this.#s.channels.chunks.push({
        at: new Date().toISOString(),
        payload: { kind: "text", text: value },
        stepId: this.name,
      });
      return;
    }
    Step.#assertSerializable(value, `${this.name}.write`);
    this.#s.channels.chunks.push({
      at: new Date().toISOString(),
      payload: { data: value, kind: "data" },
      stepId: this.name,
    });
  }

  /**
   * Drain a stream/iterable into this step's channel via {@link write}.
   *
   * On `step.signal` abort: resolves cleanly; source is canceled as fallback.
   * On source error: rejects (surfaces as normal exception in body).
   * Pre-aborted: no-op.
   */
  async pipe<T>(source: ReadableStream<T> | AsyncIterable<T>): Promise<void> {
    if (this.signal.aborted) {
      return;
    }

    if (source instanceof ReadableStream) {
      const reader = source.getReader();
      const onAbort = (): void => {
        reader.cancel().catch(() => undefined);
      };
      this.signal.addEventListener("abort", onAbort);
      try {
        while (!this.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) {
            return;
          }
          this.write(value);
        }
      } finally {
        this.signal.removeEventListener("abort", onAbort);
        try {
          reader.releaseLock();
        } catch {
          // Lock may already be released by cancel().
        }
      }
      return;
    }

    const iter: AsyncIterator<T> = source[Symbol.asyncIterator]();
    const onAbort = (): void => {
      iter.return?.().catch(() => undefined);
    };
    this.signal.addEventListener("abort", onAbort);
    try {
      while (!this.signal.aborted) {
        const result = await iter.next();
        if (result.done) {
          return;
        }
        this.write(result.value);
      }
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * @internal Dev-mode JSON-serialization guard.
   */
  static #assertSerializable(value: unknown, where: string): void {
    if (process.env.NODE_ENV === "production") {
      return;
    }
    if (value === undefined) {
      return;
    }
    try {
      JSON.stringify(value);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new TypeError(
        `${where}: value is not JSON-serializable (${reason})`,
        { cause: err }
      );
    }
  }

  // ── Snapshot reads (delegated) ───────────────────────────────────────────

  /** Current snapshot state — sync read. */
  get state(): SnapshotState {
    return Effect.runSync(this.snapshot.current);
  }

  /** Step records keyed by namespaced path — sync. */
  get steps(): Record<string, StepSnapshot> {
    return Effect.runSync(this.snapshot.currentSteps);
  }

  /** Structural workflow tree + cursor (or null for non-workflow runs) — sync. */
  get workflow(): WorkflowSnapshot | null {
    return Effect.runSync(this.snapshot.currentWorkflow);
  }

  /** Step outputs keyed by namespaced path — sync. */
  get results(): Record<string, unknown> {
    return Effect.runSync(this.snapshot.currentResults);
  }

  /** Native ReadableStream of full state changes. */
  get changes(): ReadableStream<SnapshotState> {
    return Stream.toReadableStream(this.snapshot.changes);
  }

  // ── Snapshot writes (delegated) ──────────────────────────────────────────

  /** @internal Effect-typed write. */
  #setWorkflow(workflow: WorkflowSnapshot): Effect.Effect<void> {
    return this.snapshot.setWorkflow(workflow);
  }
  /** Seed the structural workflow plan + cursor. */
  setWorkflow(workflow: WorkflowSnapshot): Promise<void> {
    return runEffectPromise(this.#setWorkflow(workflow));
  }

  /** @internal Effect-typed write. */
  #setCursor(key: string | null): Effect.Effect<void> {
    return this.snapshot.setCursor(key);
  }
  /** Move the workflow cursor (no-op when no workflow tree is seeded). */
  setCursor(key: string | null): Promise<void> {
    return runEffectPromise(this.#setCursor(key));
  }

  /** @internal Effect-typed write. */
  #markSkipped(path: readonly string[]): Effect.Effect<void> {
    return this.snapshot.markSkipped(path);
  }
  /** Mark a step skipped (branch composer / pre-execution). */
  markSkipped(path: readonly string[]): Promise<void> {
    return runEffectPromise(this.#markSkipped(path));
  }

  /** @internal Effect-typed write. */
  #markAborted(path: readonly string[]): Effect.Effect<void> {
    return this.snapshot.markAborted(path);
  }
  /** Mark a step aborted (cancel handler). */
  markAborted(path: readonly string[]): Promise<void> {
    return runEffectPromise(this.#markAborted(path));
  }

  // ── Driving ──────────────────────────────────────────────────────────────

  /** @internal Runtime bridge; preserves protected definition execute bodies. */
  invoke(
    input: I,
    context: StepContext<I, O, X>
  ):
    | Promise<O | Bail<unknown>>
    | AsyncGenerator<unknown, O | Bail<unknown>, unknown> {
    return this.execute(input, context);
  }

  /**
   * Drive this Step. Thin orchestration wrapper over the single engine
   * {@link Executable.drive}: runs in `stepMode` so the engine applies
   * the Step-only hooks (pre-exec short-circuits, pause gate, post-body
   * child cascade, `progress=100`, abort-failed suppression, and the
   * `ctx.next` / `ctx.pipe` affordances).
   *
   * `input` overrides this Step's bound input — useful when a parent's
   * execute wants to feed a different value (e.g. piping in
   * `sequence`-style composition). `ctxExtension` layers extra fields
   * onto the body's `ctx` for this call only.
   *
   * @internal Effect-typed driver. Public consumers call {@link run}
   * (Promise) which wraps this and throws {@link StepBailError} on bail.
   * The Effect form preserves the `O | Bail<unknown>` discriminant so
   * callers can branch in Effect land without throwing.
   */
  #run(
    input?: I,
    ctxExtension?: object
  ): Effect.Effect<O | Bail<unknown>, Error> {
    return this.executable.drive(
      { channels: this.channels, composer: this.composer },
      this as unknown as Step<unknown, O>,
      {
        ...(input === undefined ? {} : { input }),
        ...(ctxExtension === undefined ? {} : { ctxExtension }),
        assertResult: (value) => {
          Step.#assertSerializable(value, `${this.#specName}.complete`);
        },
        stepMode: true,
      }
    );
  }

  /**
   * Drive this step end-to-end through the framework pipeline (retry,
   * timeout, lifecycle events, snapshot updates) and resolve with the
   * produced value `O`. **Throws on bail or runtime error.**
   *
   * On bail, throws {@link StepBailError} carrying the original
   * `Bail<unknown>` so callers can branch on `instanceof` for explicit
   * bail-handling. On `SuspendSignal`, throws the signal as-is so
   * upstream `instanceof isSuspendSignal` checks survive.
   *
   * `input` overrides this Step's bound input. `ctxExtension` layers
   * extra fields onto the body's `ctx` for this call only.
   */
  run(input?: I, ctxExtension?: object): Promise<O> {
    if (this.#runtime === undefined) {
      return this.create().run(input as I, ctxExtension);
    }
    return runEffectPromise(
      this.#run(input, ctxExtension).pipe(
        Effect.flatMap((result) =>
          isBail(result)
            ? Effect.fail(new StepBailError(this.#specName, result))
            : Effect.succeed(result)
        )
      )
    );
  }
}

/** Bound runtime implementation behind legacy `Step.create(spec)`. */
class RuntimeStep<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> extends Step<I, O, X> {
  readonly #body: StepSpec<I, O, X>["execute"];

  constructor(spec: StepSpec<I, O, X>) {
    super({ spec });
    this.#body = spec.execute;
  }

  protected execute(
    input: I,
    context: StepContext<I, O, X>
  ):
    | Promise<O | Bail<unknown>>
    | AsyncGenerator<unknown, O | Bail<unknown>, unknown> {
    return this.#body.call(this, input, context);
  }
}
