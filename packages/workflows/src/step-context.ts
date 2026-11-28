import type { SuspensionRequest } from "./slices/channels";
import type { ParallelEntry, ParallelOut, RaceOut } from "./slices/composer";
import type { BaseContext, ExecutableConfig } from "./slices/executable";
import type {
  SnapshotState,
  StepSnapshot,
  StepStatus,
  WorkflowSnapshot,
} from "./slices/snapshot";
import type { Step } from "./step";
import type { Bail } from "./types";

export type StepContext<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> = X & {
  readonly step: Step<I, O, X>;
  readonly path: readonly string[];
  readonly signal: AbortSignal;
  readonly children: readonly Step[];

  readonly fork: <NewI, NewO>(
    spec: StepSpec<NewI, NewO, X>
  ) => Step<NewI, NewO, X>;

  next(): Promise<void>;

  readonly state: Promise<SnapshotState>;
  readonly steps: Promise<Record<string, StepSnapshot>>;
  readonly results: Promise<Record<string, unknown>>;
  readonly workflow: Promise<WorkflowSnapshot | null>;

  resultOf<T = unknown>(name: string): T | undefined;
  statusOf(name: string): StepStatus | undefined;

  write(value: unknown): void;

  pipe<T>(source: ReadableStream<T> | AsyncIterable<T>): Promise<void>;

  emit(type: string, payload?: unknown): void;

  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>
  ): void;

  suspend<T>(args: SuspensionRequest): Promise<T>;

  invoke<CI, CO>(step: Step<CI, CO>, input: CI, as?: string): Promise<CO>;

  parallel<Specs extends Record<string, ParallelEntry>>(
    specs: Specs,
    name?: string
  ): Promise<ParallelOut<Specs>>;

  race<Specs extends Record<string, ParallelEntry>>(
    specs: Specs,
    name?: string
  ): Promise<RaceOut<Specs>>;

  branch<CO>(
    predicate: (input: unknown) => boolean | Promise<boolean>,
    ifTrue: Step<unknown, CO>,
    ifFalse: Step<unknown, CO>,
    input: unknown,
    name?: string
  ): Promise<CO>;

  sequence<Output = unknown>(
    steps: readonly Step[],
    initialInput: unknown,
    name?: string
  ): Promise<Output>;
};

export interface StepSpec<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> {
  readonly children?: readonly (StepSpec | Step)[];
  readonly config?: Partial<ExecutableConfig>;
  readonly execute: (
    input: I,
    ctx: StepContext<I, O, X>
  ) =>
    | Promise<O | Bail<unknown>>
    | AsyncGenerator<unknown, O | Bail<unknown>, unknown>;
  readonly id?: string;
  readonly input: I;
  readonly name: string;
  readonly seed?: Omit<X, "name">;
}
