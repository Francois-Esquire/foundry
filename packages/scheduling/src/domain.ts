import type { JsonValue } from "@foundry/lib/json";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
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
  | { readonly kind: "once"; readonly at: Instant };

export type OverlapPolicy = "skip" | "allow" | "cancel-previous";
export type MisfirePolicy = "run-once" | "skip";

export interface DispatchTarget {
  readonly handler: { readonly name: string; readonly version?: string };
  readonly input: JsonValue;
  readonly policy?: { readonly retry?: unknown; readonly timeoutMs?: number };
  readonly pool?: string;
}

export interface Schedule {
  readonly cadence: Cadence;
  readonly createdAt: Instant;
  readonly id: ScheduleId;
  readonly misfire: MisfirePolicy;
  readonly overlap: OverlapPolicy;
  readonly state: "enabled" | "paused";
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

export interface Lease {
  readonly claimedAt: Instant;
  readonly owner: ProcessIdentity;
}

export type SkipReason = "overlap" | "misfire" | "paused" | "already-claimed";
export type JobOutcome = "completed" | "failed" | "cancelled";

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
  | EventOf<"ScheduleRegistered", { readonly schedule: Schedule }>
  | EventOf<"SchedulePaused", { readonly schedule: Schedule }>
  | EventOf<"ScheduleResumed", { readonly schedule: Schedule }>
  | EventOf<"ScheduleRemoved", { readonly scheduleId: ScheduleId }>
  | EventOf<"OccurrenceClaimed", { readonly occurrence: Occurrence }>
  | EventOf<"OccurrenceSkipped", { readonly occurrence: Occurrence }>
  | EventOf<"OccurrenceDispatched", { readonly occurrence: Occurrence }>
  | EventOf<"OccurrenceSettled", { readonly occurrence: Occurrence }>;

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
