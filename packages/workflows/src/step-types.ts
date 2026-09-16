import type { SuspensionRequest } from "./channels";
import type { ParallelEntry, ParallelOut, RaceOut } from "./composer";
import type { BaseContext, ExecutableConfig } from "./executable";
import type {
  SnapshotState,
  StepSnapshot,
  StepStatus,
  WorkflowSnapshot,
} from "./snapshot";
import type { Step } from "./step";
import type { Bail } from "./types";

/**
 * The body's view of the running step. Spreads the typed context `X`
 * onto framework affordances (`step`, `path`, `signal`, `children`).
 *
 * `ctx.children` — the current frame's children (declared or forked).
 *
 * `ctx.next()` — Koa-style middleware: drains pending children and
 * propagates the first failure. Bodies that skip it get fire-and-forget.
 *
 * Framework fields take precedence; `X` cannot define `step` / `path` /
 * `signal` / `children`. Built once per `step.run()`, optionally layered
 * with `ctxExtension` from `step.invoke(input, ext)`.
 */
export type StepContext<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> = X & {
  // Core members
  readonly step: Step<I, O, X>;
  readonly path: readonly string[];
  readonly signal: AbortSignal;
  readonly children: readonly Step[];

  /**
   * Create and append a dynamic child Step.
   */
  readonly fork: <NewI, NewO>(
    spec: StepSpec<NewI, NewO, X>
  ) => Step<NewI, NewO, X>;

  /**
   * Drain pending children in append order. Propagates the first failure.
   */
  next(): Promise<void>;

  // Snapshot access (Promise-wrapped)
  readonly state: Promise<SnapshotState>;
  readonly steps: Promise<Record<string, StepSnapshot>>;
  readonly results: Promise<Record<string, unknown>>;
  readonly workflow: Promise<WorkflowSnapshot | null>;

  // Path-relative helpers (sync)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-supplied type for an ergonomic typed accessor over the untyped results map
  resultOf<T = unknown>(name: string): T | undefined;
  statusOf(name: string): StepStatus | undefined;

  // Stream and events
  /**
   * Push a chunk. Strings → text; `undefined`/`null` → no-op;
   * else → data (JSON-serializable). In generators, `yield X` routes here.
   */
  write(value: unknown): void;

  /**
   * Drain a stream/iterable into this step's channel.
   */
  pipe<T>(source: ReadableStream<T> | AsyncIterable<T>): Promise<void>;

  /** Emit a custom event. */
  emit(type: string, payload?: unknown): void;

  /**
   * Emit a granular, path-scoped log line. Lands in the run's telemetry +
   * the swappable audit sink. The durable-function logging affordance.
   */
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>
  ): void;

  // Suspension
  /**
   * Suspend until a matching `resolve(name)` is called.
   */
  suspend<T>(args: SuspensionRequest): Promise<T>;

  // Composition primitives
  /**
   * Drive a pre-built child Step inline.
   */
  invoke<CI, CO>(step: Step<CI, CO>, input: CI, as?: string): Promise<CO>;

  /**
   * Run children concurrently under a group frame.
   */
  parallel<Specs extends Record<string, ParallelEntry>>(
    specs: Specs,
    name?: string
  ): Promise<ParallelOut<Specs>>;

  /**
   * First entry wins; rest are interrupted.
   */
  race<Specs extends Record<string, ParallelEntry>>(
    specs: Specs,
    name?: string
  ): Promise<RaceOut<Specs>>;

  /**
   * Predicate chooses which arm runs.
   */
  branch<CO>(
    predicate: (input: unknown) => boolean | Promise<boolean>,
    ifTrue: Step<unknown, CO>,
    ifFalse: Step<unknown, CO>,
    input: unknown,
    name?: string
  ): Promise<CO>;

  /**
   * Pipeline: each step's output feeds the next input.
   */
  sequence<O = unknown>(
    steps: readonly Step[],
    initialInput: unknown,
    name?: string
  ): Promise<O>;
};

/**
 * Declarative shape of a Step. Recursive — children are StepSpec instances
 * materialized into Step instances at construction time.
 */
export interface StepSpec<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> {
  /**
   * Children declared at spec time. Accepts either:
   *
   *   - `StepSpec` — materialized into a fresh child Step under this
   *     Step's substrate during `#initialize`.
   *   - `Step` instance — bound under this Step's substrate via the
   *     child's own `#initialize(parent)`. Useful for composing pre-built
   *     Steps from `Step.make` into a parent at construction time.
   *
   * A `Step` instance can be attached to at most one parent — passing
   * an already-bound Step to a second parent throws "already bound".
   */
  readonly children?: readonly (StepSpec | Step)[];
  readonly config?: Partial<ExecutableConfig>;
  /**
   * The body. Async function returning `Promise<O | Bail>` or
   * async generator yielding chunks and returning `O | Bail`.
   */
  readonly execute: (
    input: I,
    ctx: StepContext<I, O, X>
  ) =>
    | Promise<O | Bail<unknown>>
    | AsyncGenerator<unknown, O | Bail<unknown>, unknown>;
  /**
   * Optional stable id override — used by restore paths so a hydrated
   * Step keeps the same id as before. When omitted, the constructor
   * generates a fresh `${name}_${nonce}` id.
   */
  readonly id?: string;
  readonly input: I;
  readonly name: string;
  readonly seed?: Omit<X, "name">;
}
