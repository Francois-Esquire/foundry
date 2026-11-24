import { Context, type Effect } from "effect";
import type {
  CursorConflictError,
  Occurrence,
  OccurrenceFilter,
  OccurrenceId,
  Schedule,
  ScheduleCursor,
  ScheduleEvent,
  ScheduleId,
  SchedulerOwner,
  StoreError,
} from "../domain";

export interface ScheduleWrite {
  readonly cursors?: readonly ScheduleCursor[];
  readonly events?: readonly ScheduleEvent[];
  readonly expectedCursors?: readonly ScheduleCursor[];
  readonly maxOccurrencesPerSchedule?: number;
  readonly occurrences?: readonly Occurrence[];
  readonly removed?: readonly ScheduleId[];
  readonly schedules?: readonly Schedule[];
}

export interface ScheduleStoreService {
  readonly claim: (
    occurrence: Occurrence,
    replacing?: Occurrence
  ) => Effect.Effect<boolean, StoreError>;
  readonly commit: (
    write: ScheduleWrite
  ) => Effect.Effect<void, StoreError | CursorConflictError>;
  readonly getCursor: (
    id: ScheduleId
  ) => Effect.Effect<ScheduleCursor | undefined, StoreError>;
  readonly getOccurrence: (
    id: OccurrenceId
  ) => Effect.Effect<Occurrence | undefined, StoreError>;
  readonly getSchedule: (
    id: ScheduleId
  ) => Effect.Effect<Schedule | undefined, StoreError>;
  readonly latestOccurrence: (
    scheduleId: ScheduleId
  ) => Effect.Effect<Occurrence | undefined, StoreError>;
  readonly listOccurrences: (
    filter?: OccurrenceFilter
  ) => Effect.Effect<readonly Occurrence[], StoreError>;
  readonly listSchedules: Effect.Effect<readonly Schedule[], StoreError>;
  readonly releaseClaim: (
    id: OccurrenceId,
    owner: SchedulerOwner
  ) => Effect.Effect<void, StoreError>;
}

export class ScheduleStore extends Context.Tag(
  "@foundry/scheduling/ScheduleStore"
)<ScheduleStore, ScheduleStoreService>() {}
