import type { InstanceIdentity } from "@foundry/lib/instance-identity";
import type { JsonValue } from "@foundry/lib/json";
import { Data } from "effect";

export type JobId = `jb-${string}`;
export type RunId = `rn-${string}`;
export type SuspensionId = `su-${string}`;
export type PoolName = string;
export type Instant = number;

export const DEFAULT_POOL: PoolName = "default";

export interface HandlerRef {
  readonly name: string;
  readonly version?: string;
}

export interface ErrorShape {
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}

export type QueueOwner = InstanceIdentity;

export interface Lease {
  readonly claimedAt: Instant;
  readonly expiresAt?: Instant;
  readonly owner: QueueOwner;
}

export type Backoff =
  | { readonly kind: "fixed"; readonly delayMs: number }
  | {
      readonly kind: "exponential";
      readonly initialMs: number;
      readonly factor?: number;
      readonly maxDelayMs?: number;
    }
  | {
      readonly kind: "linear";
      readonly initialMs: number;
      readonly stepMs: number;
      readonly maxDelayMs?: number;
    }
  | {
      readonly kind: "jittered";
      readonly initialMs: number;
      readonly factor?: number;
      readonly maxDelayMs?: number;
    };

export interface RetryPolicy {
  readonly backoff?: Backoff;
  readonly maxAttempts: number;
  readonly maxElapsedMs?: number;
}

export interface ExecutionPolicy {
  readonly idempotencyKey?: string;
  readonly retry?: RetryPolicy;
  readonly timeoutMs?: number;
}

export interface Links {
  readonly parentJobId?: JobId;
  readonly parentRunId?: RunId;
  readonly source?: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly triggerId?: string;
}

export interface SuspensionRequest {
  readonly key: string;
  readonly kind: string;
  readonly reason: string;
  readonly request: JsonValue;
}

export type RunOutcome =
  | { readonly kind: "complete"; readonly output: JsonValue }
  | { readonly kind: "suspended"; readonly suspension: SuspensionRequest }
  | { readonly kind: "bailed"; readonly error: ErrorShape };

export interface ConcurrencyPool {
  readonly limit: number;
  readonly name: PoolName;
  readonly state: "active" | "paused";
}

export interface PoolStats extends ConcurrencyPool {
  readonly active: number;
  readonly waiting: number;
}

export type JobState =
  | { readonly kind: "pending" }
  | {
      readonly kind: "active";
      readonly runId: RunId;
      readonly attempt: number;
    }
  | {
      readonly kind: "suspended";
      readonly runId: RunId;
      readonly suspensionId: SuspensionId;
    }
  | {
      readonly kind: "complete";
      readonly runId: RunId;
      readonly output: JsonValue;
      readonly completedAt: Instant;
    }
  | {
      readonly kind: "failed";
      readonly lastRunId: RunId;
      readonly error: ErrorShape;
      readonly failedAt: Instant;
    }
  | {
      readonly kind: "cancelled";
      readonly reason?: string;
      readonly cancelledAt: Instant;
    };

export interface Job {
  readonly createdAt: Instant;
  readonly handler: HandlerRef;
  readonly id: JobId;
  readonly input: JsonValue;
  readonly links: Links;
  readonly policy: ExecutionPolicy;
  readonly pool: PoolName;
  readonly state: JobState;
}

export type RunState =
  | {
      readonly kind: "queued";
      readonly availableAt: Instant;
      readonly queuedAt: Instant;
      readonly owner?: QueueOwner;
    }
  | {
      readonly kind: "running";
      readonly lease: Lease;
    }
  | {
      readonly kind: "suspended";
      readonly suspensionId: SuspensionId;
      readonly suspendedAt: Instant;
    }
  | {
      readonly kind: "complete";
      readonly output: JsonValue;
      readonly completedAt: Instant;
    }
  | {
      readonly kind: "failed";
      readonly error: ErrorShape;
      readonly retryable: boolean;
      readonly failedAt: Instant;
    }
  | {
      readonly kind: "cancelled";
      readonly reason?: string;
      readonly cancelledAt: Instant;
    }
  | {
      readonly kind: "interrupted";
      readonly lease: Lease;
      readonly reason: string;
      readonly interruptedAt: Instant;
    };

export interface Run {
  readonly attempt: number;
  readonly checkpoint?: JsonValue;
  readonly id: RunId;
  readonly jobId: JobId;
  readonly pool: PoolName;
  readonly revision: number;
  readonly startedAt?: Instant;
  readonly state: RunState;
}

export type SuspensionState =
  | { readonly kind: "pending"; readonly createdAt: Instant }
  | {
      readonly kind: "resolved";
      readonly value: JsonValue;
      readonly resolvedAt: Instant;
    }
  | {
      readonly kind: "cancelled";
      readonly reason?: string;
      readonly cancelledAt: Instant;
    };

export interface Suspension {
  readonly id: SuspensionId;
  readonly key: string;
  readonly kind: string;
  readonly reason: string;
  readonly request: JsonValue;
  readonly revision: number;
  readonly runId: RunId;
  readonly state: SuspensionState;
}

type EventOf<Type extends string, Fields> = {
  readonly at: Instant;
  readonly id: string;
  readonly type: Type;
} & Fields;

export type QueueEvent =
  | EventOf<"job.submitted", { readonly job: Job }>
  | EventOf<"job.settled", { readonly job: Job }>
  | EventOf<
      "job.removed",
      { readonly job: Job; readonly runIds: readonly RunId[] }
    >
  | EventOf<"run.queued", { readonly run: Run }>
  | EventOf<"run.started", { readonly run: Run }>
  | EventOf<"run.suspended", { readonly run: Run }>
  | EventOf<"run.resumed", { readonly run: Run }>
  | EventOf<"run.completed", { readonly run: Run }>
  | EventOf<"run.failed", { readonly run: Run }>
  | EventOf<"run.cancelled", { readonly run: Run }>
  | EventOf<"run.interrupted", { readonly run: Run }>
  | EventOf<
      "run.handed_over",
      { readonly run: Run; readonly successor: QueueOwner }
    >
  | EventOf<"suspension.opened", { readonly suspension: Suspension }>
  | EventOf<"suspension.resolved", { readonly suspension: Suspension }>
  | EventOf<"suspension.cancelled", { readonly suspension: Suspension }>;

export type QueueEventType = QueueEvent["type"];

export interface JobFilter {
  readonly idempotencyKey?: string;
  readonly state?: JobState["kind"];
}

export interface RunFilter {
  readonly jobId?: JobId;
  readonly state?: RunState["kind"];
}

export interface SuspensionFilter {
  readonly runId?: RunId;
  readonly state?: SuspensionState["kind"];
}

export interface RecoverySummary {
  readonly interrupted: readonly RunId[];
  readonly readmitted: readonly RunId[];
}

export class JobNotFoundError extends Data.TaggedError("JobNotFoundError")<{
  readonly id: JobId;
}> {}

export class RunNotFoundError extends Data.TaggedError("RunNotFoundError")<{
  readonly id: RunId;
}> {}

export class RunAlreadyExistsError extends Data.TaggedError(
  "RunAlreadyExistsError"
)<{ readonly id: RunId }> {}

export class SuspensionNotFoundError extends Data.TaggedError(
  "SuspensionNotFoundError"
)<{
  readonly id: SuspensionId;
}> {}

export class HandlerNotRegisteredError extends Data.TaggedError(
  "HandlerNotRegisteredError"
)<{ readonly name: string }> {}

export class HandlerAlreadyRegisteredError extends Data.TaggedError(
  "HandlerAlreadyRegisteredError"
)<{ readonly name: string }> {}

export class SuspensionAlreadySettledError extends Data.TaggedError(
  "SuspensionAlreadySettledError"
)<{ readonly suspension: Suspension }> {}

export class StaleSuspensionRevisionError extends Data.TaggedError(
  "StaleSuspensionRevisionError"
)<{ readonly expectedRevision: number; readonly suspension: Suspension }> {}

export class JobRemovedError extends Data.TaggedError("JobRemovedError")<{
  readonly id: JobId;
}> {}

export class JobNotSettledError extends Data.TaggedError("JobNotSettledError")<{
  readonly job: Job;
}> {}

export class QueueRetiringError extends Data.TaggedError("QueueRetiringError")<{
  readonly handler: string;
}> {}

export class InvalidPoolLimitError extends Data.TaggedError(
  "InvalidPoolLimitError"
)<{ readonly pool: PoolName; readonly limit: number }> {}

export class InvalidRetryPolicyError extends Data.TaggedError(
  "InvalidRetryPolicyError"
)<{ readonly reason: string }> {}

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly cause: unknown;
}> {}

export class WriteConflictError extends Data.TaggedError("WriteConflictError")<{
  readonly id: string;
}> {}

export type QueueError =
  | JobNotFoundError
  | RunNotFoundError
  | RunAlreadyExistsError
  | SuspensionNotFoundError
  | HandlerNotRegisteredError
  | SuspensionAlreadySettledError
  | StaleSuspensionRevisionError
  | JobNotSettledError
  | JobRemovedError
  | QueueRetiringError
  | InvalidRetryPolicyError
  | StoreError
  | WriteConflictError;

export const isTerminalJob = (state: JobState): boolean =>
  state.kind === "complete" ||
  state.kind === "failed" ||
  state.kind === "cancelled";

export const isOpenRun = (state: RunState): boolean =>
  state.kind === "queued" ||
  state.kind === "running" ||
  state.kind === "suspended";
