export type { ErrorShape, QueueStatus, RunStatus } from "./schema";

export type Duration = number | string;

export interface RetryPolicy {
  readonly backoff?: BackoffStrategy;
  readonly maxAttempts?: number;
  readonly maxElapsed?: Duration;
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export type BackoffStrategy =
  | { kind: "fixed"; delay: Duration }
  | { kind: "exponential"; initial: Duration; factor?: number; max?: Duration }
  | { kind: "linear"; initial: Duration; step: Duration; max?: Duration }
  | { kind: "jittered"; initial: Duration; max: Duration };

export type CancellationSignal = AbortSignal;

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export type Unsubscribe = () => void;

export interface Bail<E> {
  readonly _bail: true;
  readonly error: E;
}

export function bail<E>(error: E): Bail<E> {
  return { _bail: true, error };
}

export function isBail<E>(value: unknown): value is Bail<E> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _bail?: unknown })._bail === true
  );
}

export class StepBailError extends Error {
  readonly bail: Bail<unknown>;
  readonly stepName: string;
  constructor(stepName: string, bailResult: Bail<unknown>) {
    super(`Step "${stepName}" bailed: ${JSON.stringify(bailResult.error)}`);
    this.name = "StepBailError";
    this.stepName = stepName;
    this.bail = bailResult;
  }
}

export const isStepBailError = (e: unknown): e is StepBailError =>
  e instanceof StepBailError;
