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
import { isBail, StepBailError } from "./types";

export type { StepContext, StepSpec } from "./step-types";
// biome-ignore lint/performance/noBarrelFile: Preserve the declared @foundry/workflows/step compatibility API.
export { isStepBailError, StepBailError } from "./types";

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

export abstract class Step<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> {
  readonly kind = "step" as const;

  readonly definitionKey?: string;
  declare readonly name: string;
  readonly description?: string;
  declare __definitionInput?: (input: I) => void;
  declare __definitionOutput?: () => O;
  declare __definitionContext?: (context: X) => void;

  protected abstract execute(
    input: I,
    ctx: StepContext<I, O, X>
  ):
    | Promise<O | Bail<unknown>>
    | AsyncGenerator<unknown, O | Bail<unknown>, unknown>;

  readonly #children: Step[] = [];

  readonly #runtime: StepRuntime<I, X> | undefined;
  #definitionPlan: LeafDefinitionPlan<I, O, X> | undefined;

  // biome-ignore lint/style/useReadonlyClassProperties: A parent claims a child after construction to prevent premature binding.
  #claimedByParent = false as boolean;

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

  get #s() {
    return this.#ensureSubstrate();
  }

  #ensureSubstrate() {
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
    const substrate = this.#substrate;
    if (substrate === undefined) {
      throw new Error(
        "Step initialization did not create a runtime substrate."
      );
    }
    return substrate;
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
    for (const childOrSpec of this.#pendingChildren) {
      if (childOrSpec instanceof Step) {
        if (childOrSpec.#substrate || childOrSpec.#claimedByParent) {
          throw new Error(`Step "${childOrSpec.#specName}" is already bound`);
        }
        childOrSpec.#claimedByParent = true;
      }
    }
    this.name = spec.name;
  }

  get id(): string {
    if (this.#runtime === undefined) {
      throw new Error(
        "Definition Steps do not have a runtime id; call create(input) first."
      );
    }
    return this.#runtime.id;
  }

  get definition(): DefinitionDescriptor {
    return describeLeafDefinition(this.#plan());
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

  #materialize(input: I, binding?: DefinitionBinding<X>): Step<I, O, X> {
    return this[definitionMaterializer](
      input,
      binding,
      this.#plan().definitionKey
    );
  }

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

  /** @internal */
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

  /** @internal */
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

  /** @internal */
  static #new<Input, Output, Context extends BaseContext = BaseContext>(
    spec: StepSpec<Input, Output, Context>
  ): Step<Input, Output, Context> {
    return new RuntimeStep<Input, Output, Context>(spec);
  }

  /** @internal */
  #materializeSpecChild(spec: StepSpec): Step {
    const child = Step.#new(spec);
    child.#initialize(this as unknown as Step);
    return child;
  }

  static create<Input, Output, Context extends BaseContext = BaseContext>(
    spec: StepSpec<Input, Output, Context>
  ): Step<Input, Output, Context> {
    return Step.#new(spec);
  }

  static make<Input, Output, Context extends BaseContext = BaseContext>(
    spec: StepSpec<Input, Output, Context>
  ): Promise<Step<Input, Output, Context>> {
    return Promise.resolve(Step.create<Input, Output, Context>(spec));
  }

  static from<Output = unknown>(
    name: string,
    body: () => Promise<Output | Bail<unknown>>
  ): Promise<Step<void, Output>> {
    return Step.make<void, Output>({
      execute: () => body(),
      input: undefined,
      name,
    });
  }

  dispose(): Promise<void> {
    if (!this.#substrate) {
      return Promise.resolve();
    }
    return Effect.runPromise(Scope.close(this.#substrate.scope, Exit.void));
  }

  get children(): readonly Step[] {
    this.#ensureSubstrate();
    return this.#children;
  }

  /** @internal */
  get snapshot(): Snapshot {
    return this.#s.snapshot;
  }
  /** @internal */
  get channels(): Channels {
    return this.#s.channels;
  }
  get channelStream(): ReadableStream<ChannelMessage> {
    return this.#s.channels.stream;
  }
  subscribe(signal?: AbortSignal): ReadableStream<ChannelMessage> {
    return this.#s.channels.subscribe(signal);
  }
  /** @internal */
  get executable(): Executable<I, X> {
    return this.#s.executable;
  }
  /** @internal */
  get composer(): Composer {
    return this.#s.composer;
  }

  fork<NewI, NewO>(spec: StepSpec<NewI, NewO, X>): Step<NewI, NewO, X> {
    const child = this.#materializeSpecChild(
      spec as unknown as StepSpec
    ) as unknown as Step<NewI, NewO, X>;
    this.#children.push(child as unknown as Step);
    return child;
  }

  step<NewI, NewO, CX extends BaseContext = X>(
    specOrStep: StepSpec<NewI, NewO, CX> | Step<NewI, NewO, CX>
  ): this {
    const isStep = specOrStep instanceof Step;
    if (this.#substrate) {
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
      this.fork(specOrStep as unknown as StepSpec<NewI, NewO, X>);
      return this;
    }
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

  get status(): StepStatus {
    const state = Effect.runSync(this.snapshot.current);
    const key = this.path.join(".");
    return state.steps[key]?.status ?? "pending";
  }

  /** @internal */
  get #statusChanges(): Stream.Stream<StepStatus> {
    const key = this.path.join(".");
    return this.snapshot.stepsChanges.pipe(
      Stream.map((steps) => steps[key]?.status ?? "pending"),
      Stream.changes
    );
  }

  get statusChanges(): ReadableStream<StepStatus> {
    return Stream.toReadableStream(this.#statusChanges);
  }

  get output(): O | undefined {
    const state = Effect.runSync(this.snapshot.current);
    const key = this.path.join(".");
    return state.steps[key]?.output as O | undefined;
  }

  /** @internal */
  get #outputChanges(): Stream.Stream<O> {
    return this.channels.outputFor<O>(this.path);
  }

  get outputChanges(): ReadableStream<O> {
    return Stream.toReadableStream(this.#outputChanges);
  }

  get isTerminal(): boolean {
    const s = this.status;
    return (
      s === "complete" || s === "failed" || s === "aborted" || s === "skipped"
    );
  }

  get paused(): boolean {
    return this.status === "paused";
  }

  get progress(): number {
    const state = Effect.runSync(this.snapshot.current);
    const key = this.path.join(".");
    return state.steps[key]?.progress ?? 0;
  }

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

  /** @internal */
  get #progressChanges(): Stream.Stream<number> {
    return this.channels.progressFor(this.path);
  }

  get progressChanges(): ReadableStream<number> {
    return Stream.toReadableStream(this.#progressChanges);
  }

  #publishProgress(value: number): void {
    this.channels.progress(
      this.path,
      this.name,
      this.#attemptFromSnapshot(),
      value
    );
  }

  get aborted(): boolean {
    return this.executable.aborted;
  }
  get reason(): unknown {
    return this.executable.reason;
  }

  get signal(): AbortSignal {
    return this.executable.signal;
  }

  abort(reason?: unknown): void {
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
  onAbort(handler: (reason: unknown) => void): Unsubscribe {
    return this.executable.onAbort(handler);
  }

  /** @internal */
  #suspend<T>(
    args: SuspensionRequest,
    occurrence?: number
  ): Effect.Effect<T, Error> {
    return this.executable.suspend<T>(args, occurrence);
  }

  suspend<T>(args: SuspensionRequest, occurrence?: number): Promise<T> {
    return runEffectPromise(this.#suspend<T>(args, occurrence));
  }

  /** @internal */
  #resolve(name: string, value: unknown): Effect.Effect<void> {
    return this.executable.resolve(name, value);
  }

  resolve(name: string, value: unknown): Promise<void> {
    return runEffectPromise(this.#resolve(name, value));
  }

  /** @internal */
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

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.channels.resumed(this.path, this.name, this.#attemptFromSnapshot());
  }

  skip(reason?: string): void {
    const s = this.status;
    if (s !== "pending") {
      throw new Error(
        `step.skip(): can only skip a pending step (current status: "${s}")`
      );
    }
    this.channels.skipped(this.path, this.name, 0, reason);
  }

  waitIfPaused(): Promise<void> {
    return runEffectPromise(this.#waitWhilePaused());
  }

  /** @internal */
  #waitWhilePaused(): Effect.Effect<void> {
    return this.#statusChanges.pipe(
      Stream.filter((s) => s !== "paused"),
      Stream.take(1),
      Stream.runDrain
    );
  }

  /** @internal */
  #attemptFromSnapshot(): number {
    const state = Effect.runSync(this.snapshot.current);
    const key = this.path.join(".");
    return state.steps[key]?.attempt ?? 0;
  }

  emit(type: string, payload?: unknown): void {
    this.channels.custom(type, this.name, this.path, payload);
  }

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

  get stream(): ReadableStream<ChunkPayload> {
    return this.channels.chunksFor(this.name, this.signal, this.path);
  }

  write(value: unknown): void {
    if (value === undefined || value === null) {
      return;
    }
    if (typeof value === "string") {
      this.#s.channels.chunks.push({
        at: new Date().toISOString(),
        path: this.path,
        payload: { kind: "text", text: value },
        stepId: this.name,
      });
      return;
    }
    Step.#assertSerializable(value, `${this.name}.write`);
    this.#s.channels.chunks.push({
      at: new Date().toISOString(),
      path: this.path,
      payload: { data: value, kind: "data" },
      stepId: this.name,
    });
  }

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
        releaseReader(reader);
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

  /** @internal */
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

  get state(): SnapshotState {
    return Effect.runSync(this.snapshot.current);
  }

  get steps(): Record<string, StepSnapshot> {
    return Effect.runSync(this.snapshot.currentSteps);
  }

  get workflow(): WorkflowSnapshot | null {
    return Effect.runSync(this.snapshot.currentWorkflow);
  }

  get results(): Record<string, unknown> {
    return Effect.runSync(this.snapshot.currentResults);
  }

  get changes(): ReadableStream<SnapshotState> {
    return Stream.toReadableStream(this.snapshot.changes);
  }

  /** @internal */
  #setWorkflow(workflow: WorkflowSnapshot): Effect.Effect<void> {
    return this.snapshot.setWorkflow(workflow);
  }
  setWorkflow(workflow: WorkflowSnapshot): Promise<void> {
    return runEffectPromise(this.#setWorkflow(workflow));
  }

  /** @internal */
  #setCursor(key: string | null): Effect.Effect<void> {
    return this.snapshot.setCursor(key);
  }
  setCursor(key: string | null): Promise<void> {
    return runEffectPromise(this.#setCursor(key));
  }

  /** @internal */
  #markSkipped(path: readonly string[]): Effect.Effect<void> {
    return this.snapshot.markSkipped(path);
  }
  markSkipped(path: readonly string[]): Promise<void> {
    return runEffectPromise(this.#markSkipped(path));
  }

  /** @internal */
  #markAborted(path: readonly string[]): Effect.Effect<void> {
    return this.snapshot.markAborted(path);
  }
  markAborted(path: readonly string[]): Promise<void> {
    return runEffectPromise(this.#markAborted(path));
  }

  /** @internal */
  invoke(
    input: I,
    context: StepContext<I, O, X>
  ):
    | Promise<O | Bail<unknown>>
    | AsyncGenerator<unknown, O | Bail<unknown>, unknown> {
    return this.execute(input, context);
  }

  /** @internal */
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

function releaseReader(reader: { releaseLock(): void }): void {
  try {
    reader.releaseLock();
  } catch {
    // biome-ignore lint/complexity/noUselessReturn: End the best-effort operation on failure.
    return;
  }
}
