/**
 * Shared types used across the workflow primitives.
 */

export {
  DefinitionNotRegisteredError,
  ExecutionConflictRetriesExhaustedError,
  InconsistentStoreSnapshotError,
  InvalidRunFrameSequenceError,
  InvalidStoreSnapshotError,
  JobAlreadySettledError,
  JobAttemptAlreadyActiveError,
  JobNotFoundError,
  OrchestratorNotStartedError,
  RecordAlreadyExistsError,
  RecordInUseError,
  RecoverableDefinitionMissingError,
  RunAlreadySettledError,
  RunNotFoundError,
  RunNotSuspendedError,
  RunReplayGapError,
  StaleSuspensionRevisionError,
  SuspensionAlreadySettledError,
  SuspensionNotFoundError,
  SuspensionOccurrenceMismatchError,
  UnsupportedStoreSnapshotVersionError,
  WorkflowDomainError,
} from "./errors";

/** Lifecycle status owned by the workflows execution boundary. */
export type RunStatus =
  | "queued"
  | "running"
  | "suspended"
  | "complete"
  | "failed"
  | "cancelled";

/** Operating state of a queue, distinct from an individual run outcome. */
export type QueueStatus = "active" | "paused" | "draining" | "stopped";
export type { ErrorShape } from "./workflow";

/**
 * A duration. Either ms (number) or a human-friendly string (e.g.
 * `"3s"`, `"5m"`, `"2h"`).
 */
export type Duration = number | string;

/**
 * Composable retry policy. Authors declare *what* they want; the runtime
 * decides *how* to schedule.
 */
export interface RetryPolicy {
  readonly backoff?: BackoffStrategy;
  readonly maxAttempts?: number;
  readonly maxElapsed?: Duration;
  /** Decide per-error whether a retry is appropriate. */
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export type BackoffStrategy =
  | { kind: "fixed"; delay: Duration }
  | { kind: "exponential"; initial: Duration; factor?: number; max?: Duration }
  | { kind: "linear"; initial: Duration; step: Duration; max?: Duration }
  | { kind: "jittered"; initial: Duration; max: Duration };

/** Cooperative cancellation token. Aliased so callers don't need DOM lib. */
export type CancellationSignal = AbortSignal;

/** Tiny logger contract — anything matching this works. */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Returned by emitters / subscriptions to detach the listener. */
export type Unsubscribe = () => void;

/**
 * A typed-error result returned by Steps that want to surface a business
 * failure as a value rather than throwing. The runtime treats `bail` as
 * a *terminal* failure for that step — no retries.
 */
export interface Bail<E> {
  readonly _bail: true;
  readonly error: E;
}

/** Helper to construct a {@link Bail} value. */
export function bail<E>(error: E): Bail<E> {
  return { _bail: true, error };
}

/** Type guard for {@link Bail}. */
export function isBail<E>(value: unknown): value is Bail<E> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _bail?: unknown })._bail === true
  );
}

/**
 * Thrown by the Promise form of step.run / composition primitives when
 * a body returns a `Bail<unknown>`. Carries the original Bail so
 * consumers can branch on `instanceof StepBailError` to inspect the
 * bailed value while still using a normal try/catch flow.
 */
export class StepBailError extends Error {
  readonly bail: Bail<unknown>;
  readonly stepName: string;
  constructor(stepName: string, bail: Bail<unknown>) {
    super(`Step "${stepName}" bailed: ${JSON.stringify(bail.error)}`);
    this.name = "StepBailError";
    this.stepName = stepName;
    this.bail = bail;
  }
}

/** Type guard for {@link StepBailError}. */
export const isStepBailError = (e: unknown): e is StepBailError =>
  e instanceof StepBailError;
