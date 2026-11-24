import type { InstanceIdentity } from "@foundry/lib/instance-identity";
import type { JsonValue } from "@foundry/lib/json";
import { Data } from "effect";

export type ScheduleId = string;
export type OccurrenceId = `${ScheduleId}:${number}`;
export type Instant = number;

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export type Cadence =
  | { readonly kind: "interval"; readonly everyMs: number }
  | {
      readonly kind: "calendar";
      readonly hour: number;
      readonly minute: number;
      readonly weekdays?: readonly Weekday[];
      readonly timezone: string;
    }
  | {
      readonly kind: "cron";
      readonly expression: string;
      readonly timezone: string;
    }
  | { readonly kind: "once"; readonly at: Instant }
  | {
      readonly kind: "delay";
      readonly afterSettleMs: number;
      readonly initialDelayMs?: number;
    };

export type OverlapPolicy = "skip" | "allow" | "cancel-previous";
export type MisfirePolicy = "run-once" | "skip";

export type Backoff =
  | { readonly kind: "fixed"; readonly delayMs: number }
  | {
      readonly kind: "exponential" | "jittered";
      readonly initialMs: number;
      readonly factor?: number;
      readonly maxDelayMs?: number;
    }
  | {
      readonly kind: "linear";
      readonly initialMs: number;
      readonly stepMs: number;
      readonly maxDelayMs?: number;
    };

export interface RetryPolicy {
  readonly backoff?: Backoff;
  readonly maxAttempts: number;
  readonly maxElapsedMs?: number;
}

export interface DispatchTarget {
  readonly handler: { readonly name: string; readonly version?: string };
  readonly input: JsonValue;
  readonly policy?: {
    readonly retry?: RetryPolicy;
    readonly timeoutMs?: number;
  };
  readonly pool?: string;
}

export interface Schedule {
  readonly cadence: Cadence;
  readonly createdAt: Instant;
  readonly id: ScheduleId;
  readonly misfire: MisfirePolicy;
  readonly overlap: OverlapPolicy;
  readonly state: "active" | "paused";
  readonly target: DispatchTarget;
}

export interface RegisterScheduleInput {
  readonly cadence: Cadence;
  readonly id: ScheduleId;
  readonly misfire?: MisfirePolicy;
  readonly overlap?: OverlapPolicy;
  readonly state?: Schedule["state"];
  readonly target: DispatchTarget;
}

export type SchedulerOwner = InstanceIdentity;

export interface Lease {
  readonly claimedAt: Instant;
  readonly owner: SchedulerOwner;
}

export type SkipReason = "overlap" | "misfire" | "already-claimed";
export type JobOutcome = "complete" | "failed" | "cancelled";

export type OccurrenceState =
  | {
      readonly kind: "claimed";
      readonly lease: Lease;
      readonly claimedAt: Instant;
    }
  | {
      readonly kind: "dispatched";
      readonly jobId: string;
      readonly dispatchedAt: Instant;
    }
  | {
      readonly kind: "skipped";
      readonly reason: SkipReason;
      readonly at: Instant;
    }
  | {
      readonly kind: "settled";
      readonly jobId: string;
      readonly outcome: JobOutcome;
      readonly settledAt: Instant;
    };

export interface Occurrence {
  readonly id: OccurrenceId;
  readonly scheduledFor: Instant;
  readonly scheduleId: ScheduleId;
  readonly state: OccurrenceState;
}

export interface ScheduleCursor {
  readonly activeJobId?: string;
  readonly lastScheduledFor?: Instant;
  readonly lastSettledAt?: Instant;
  readonly nextDueAt: Instant | null;
  readonly scheduleId: ScheduleId;
}

export interface OccurrenceFilter {
  readonly scheduleId?: ScheduleId;
  readonly state?: OccurrenceState["kind"];
}

type EventOf<Type extends string, Fields> = {
  readonly at: Instant;
  readonly id: string;
  readonly type: Type;
} & Fields;

export type ScheduleEvent =
  | EventOf<"schedule.registered", { readonly schedule: Schedule }>
  | EventOf<"schedule.paused", { readonly schedule: Schedule }>
  | EventOf<"schedule.resumed", { readonly schedule: Schedule }>
  | EventOf<"schedule.removed", { readonly scheduleId: ScheduleId }>
  | EventOf<"occurrence.claimed", { readonly occurrence: Occurrence }>
  | EventOf<"occurrence.skipped", { readonly occurrence: Occurrence }>
  | EventOf<"occurrence.dispatched", { readonly occurrence: Occurrence }>
  | EventOf<"occurrence.settled", { readonly occurrence: Occurrence }>;

export class InvalidCadenceError extends Data.TaggedError(
  "InvalidCadenceError"
)<{ readonly cadence: unknown; readonly reason: string }> {}

export class ScheduleNotFoundError extends Data.TaggedError(
  "ScheduleNotFoundError"
)<{ readonly id: ScheduleId }> {}

export class DispatchError extends Data.TaggedError("DispatchError")<{
  readonly cause: unknown;
}> {}

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly cause: unknown;
}> {}

export type ScheduleError =
  | InvalidCadenceError
  | ScheduleNotFoundError
  | DispatchError
  | StoreError;

export const occurrenceId = (
  scheduleId: ScheduleId,
  scheduledFor: Instant
): OccurrenceId => `${scheduleId}:${scheduledFor}`;
