import { Context, type Effect } from "effect";
import type {
  DispatchError,
  DispatchTarget,
  Instant,
  JobOutcome,
  ScheduleId,
} from "./domain";

export interface DispatchRequest {
  readonly idempotencyKey: string;
  readonly scheduledFor: Instant;
  readonly scheduleId: ScheduleId;
  readonly target: DispatchTarget;
}

export type DispatchStatus = "open" | JobOutcome;

export interface ScheduleDispatchService {
  readonly cancel: (
    jobId: string,
    reason?: string
  ) => Effect.Effect<void, DispatchError>;
  readonly status: (
    jobId: string
  ) => Effect.Effect<DispatchStatus, DispatchError>;
  readonly submit: (
    request: DispatchRequest
  ) => Effect.Effect<{ readonly jobId: string }, DispatchError>;
}

export class ScheduleDispatch extends Context.Tag(
  "@foundry/scheduling/ScheduleDispatch"
)<ScheduleDispatch, ScheduleDispatchService>() {}
