import type { JsonValue } from "@foundry/lib/json";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import { Data } from "effect";

export type JobId = `jb-${string}`;
export type RunId = `rn-${string}`;
export type WaitId = `wt-${string}`;
export type PoolName = string;
export type Instant = number;

export const DEFAULT_POOL: PoolName = "default";

export interface HandlerRef {
  readonly name: string;
  readonly version?: string;
}

export interface Failure {
  readonly code: string;
  readonly message: string;
  readonly stack?: string;
}

export interface Lease {
  readonly claimedAt: Instant;
  readonly expiresAt?: Instant;
  readonly owner: ProcessIdentity;
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

export interface CausalLinks {
  readonly parentJobId?: JobId;
  readonly parentRunId?: RunId;
  readonly source?: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly triggerId?: string;
}

export interface WaitRequest {
  readonly key: string;
  readonly kind: string;
  readonly reason: string;
  readonly request: JsonValue;
}

export type RunOutcome =
  | { readonly kind: "completed"; readonly output: JsonValue }
  | { readonly kind: "parked"; readonly wait: WaitRequest }
  | { readonly kind: "bailed"; readonly error: Failure };

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
      readonly kind: "waiting";
      readonly runId: RunId;
      readonly waitId: WaitId;
    }
  | {
      readonly kind: "completed";
      readonly runId: RunId;
      readonly output: JsonValue;
      readonly completedAt: Instant;
    }
  | {
      readonly kind: "failed";
      readonly lastRunId: RunId;
      readonly error: Failure;
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
  readonly links: CausalLinks;
  readonly policy: ExecutionPolicy;
  readonly pool: PoolName;
  readonly state: JobState;
}

export type RunState =
  | {
      readonly kind: "queued";
      readonly availableAt: Instant;
      readonly queuedAt: Instant;
      readonly owner?: ProcessIdentity;
    }
  | {
      readonly kind: "running";
      readonly lease: Lease;
      readonly startedAt: Instant;
    }
  | {
      readonly kind: "parked";
      readonly waitId: WaitId;
      readonly parkedAt: Instant;
    }
  | {
      readonly kind: "completed";
      readonly output: JsonValue;
      readonly startedAt: Instant;
      readonly completedAt: Instant;
    }
  | {
      readonly kind: "failed";
      readonly error: Failure;
      readonly retryable: boolean;
      readonly startedAt: Instant;
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
  readonly state: RunState;
}

export type WaitState =
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

export interface Wait {
  readonly id: WaitId;
  readonly key: string;
  readonly kind: string;
  readonly reason: string;
  readonly request: JsonValue;
  readonly revision: number;
  readonly runId: RunId;
  readonly state: WaitState;
}

type EventOf<Type extends string, Fields> = {
  readonly at: Instant;
  readonly id: string;
  readonly type: Type;
} & Fields;

export type QueueEvent =
  | EventOf<"JobSubmitted", { readonly job: Job }>
  | EventOf<"JobSettled", { readonly job: Job }>
  | EventOf<"RunQueued", { readonly run: Run }>
  | EventOf<"RunStarted", { readonly run: Run }>
  | EventOf<"RunParked", { readonly run: Run }>
  | EventOf<"RunResumed", { readonly run: Run }>
  | EventOf<"RunCompleted", { readonly run: Run }>
  | EventOf<"RunFailed", { readonly run: Run }>
  | EventOf<"RunCancelled", { readonly run: Run }>
  | EventOf<"RunInterrupted", { readonly run: Run }>
  | EventOf<
      "RunHandedOver",
      { readonly run: Run; readonly successor: ProcessIdentity }
    >
  | EventOf<"WaitOpened", { readonly wait: Wait }>
  | EventOf<"WaitResolved", { readonly wait: Wait }>
  | EventOf<"WaitCancelled", { readonly wait: Wait }>;

export type QueueEventType = QueueEvent["type"];

export interface JobFilter {
  readonly idempotencyKey?: string;
  readonly state?: JobState["kind"];
}

export interface RunFilter {
  readonly jobId?: JobId;
  readonly state?: RunState["kind"];
}

export interface WaitFilter {
  readonly runId?: RunId;
  readonly state?: WaitState["kind"];
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

export class WaitNotFoundError extends Data.TaggedError("WaitNotFoundError")<{
  readonly id: WaitId;
}> {}

export class HandlerNotRegisteredError extends Data.TaggedError(
  "HandlerNotRegisteredError"
)<{ readonly name: string }> {}

export class HandlerAlreadyRegisteredError extends Data.TaggedError(
  "HandlerAlreadyRegisteredError"
)<{ readonly name: string }> {}

export class WaitAlreadySettledError extends Data.TaggedError(
  "WaitAlreadySettledError"
)<{ readonly wait: Wait }> {}

export class QueueRetiringError extends Data.TaggedError("QueueRetiringError")<{
  readonly handler: string;
}> {}

export class InvalidPoolLimitError extends Data.TaggedError(
  "InvalidPoolLimitError"
)<{ readonly pool: PoolName; readonly limit: number }> {}

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly cause: unknown;
}> {}

export type QueueError =
  | JobNotFoundError
  | RunNotFoundError
  | WaitNotFoundError
  | HandlerNotRegisteredError
  | WaitAlreadySettledError
  | QueueRetiringError
  | StoreError;

export const isTerminalJob = (state: JobState): boolean =>
  state.kind === "completed" ||
  state.kind === "failed" ||
  state.kind === "cancelled";

export const isOpenRun = (state: RunState): boolean =>
  state.kind === "queued" ||
  state.kind === "running" ||
  state.kind === "parked";
