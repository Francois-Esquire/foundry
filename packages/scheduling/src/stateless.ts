import { Clock, Effect } from "effect";
import { firstDue, validateCadence, validatePolicies } from "./cadence";
import {
  type Instant,
  type RegisterScheduleInput,
  type Schedule,
  type ScheduleCursor,
  type ScheduleError,
  type ScheduleId,
  ScheduleNotFoundError,
} from "./domain";
import { type Commit, makeStoreCommit, sameJson } from "./evaluator";
import type { ScheduleStoreService } from "./store/index";

export interface StatelessScheduleOptions {
  readonly commit?: Commit;
  readonly now?: Instant;
}

const resolveCommit = (
  store: ScheduleStoreService,
  options: StatelessScheduleOptions
): Commit => options.commit ?? makeStoreCommit(store);

const retryingScheduleConflicts = <A>(
  attempt: Effect.Effect<A, ScheduleError>
) =>
  Effect.retry(attempt, {
    times: 3,
    while: (error) => error._tag === "ScheduleConflictError",
  });

const retryingWriteConflicts = <A>(attempt: Effect.Effect<A, ScheduleError>) =>
  Effect.retry(attempt, {
    times: 3,
    while: (error) =>
      error._tag === "ScheduleConflictError" ||
      error._tag === "CursorConflictError",
  });

const requireSchedule = (store: ScheduleStoreService, id: ScheduleId) =>
  Effect.flatMap(store.getSchedule(id), (schedule) =>
    schedule === undefined
      ? Effect.fail(new ScheduleNotFoundError({ id }))
      : Effect.succeed(schedule)
  );

export const registerSchedule = (
  store: ScheduleStoreService,
  input: RegisterScheduleInput,
  options: StatelessScheduleOptions = {}
): Effect.Effect<Schedule, ScheduleError> => {
  const commit = resolveCommit(store, options);
  return retryingWriteConflicts(
    Effect.gen(function* () {
      const cadence = yield* validateCadence(input.cadence);
      const misfire = input.misfire ?? "run-once";
      const overlap = input.overlap ?? "skip";
      yield* validatePolicies(cadence, overlap, misfire);
      const now = options.now ?? (yield* Clock.currentTimeMillis);
      const existing = yield* store.getSchedule(input.id);
      const previous = yield* store.getCursor(input.id);
      const schedule: Schedule = {
        cadence,
        createdAt: existing?.createdAt ?? now,
        id: input.id,
        misfire,
        overlap,
        state: input.state ?? existing?.state ?? "active",
        target: input.target,
      };
      const keepsCursor =
        existing !== undefined &&
        previous !== undefined &&
        sameJson(existing.cadence, cadence);
      const cursor: ScheduleCursor = {
        ...previous,
        nextDueAt: firstDue(cadence, now),
        scheduleId: input.id,
      };
      yield* commit(now, [{ schedule, type: "schedule.registered" }], {
        ...(keepsCursor ? {} : { cursors: [cursor] }),
        ...(keepsCursor || previous === undefined
          ? {}
          : { expectedCursors: [previous] }),
        ...(existing === undefined ? {} : { expectedSchedules: [existing] }),
        schedules: [schedule],
      });
      return schedule;
    })
  );
};

const setScheduleState = (
  store: ScheduleStoreService,
  id: ScheduleId,
  state: Schedule["state"],
  options: StatelessScheduleOptions = {}
): Effect.Effect<Schedule, ScheduleError> => {
  const commit = resolveCommit(store, options);
  return retryingScheduleConflicts(
    Effect.gen(function* () {
      const existing = yield* requireSchedule(store, id);
      const schedule: Schedule = { ...existing, state };
      const now = options.now ?? (yield* Clock.currentTimeMillis);
      yield* commit(
        now,
        [
          {
            schedule,
            type: state === "paused" ? "schedule.paused" : "schedule.resumed",
          },
        ],
        { expectedSchedules: [existing], schedules: [schedule] }
      );
      return schedule;
    })
  );
};

export const pauseSchedule = (
  store: ScheduleStoreService,
  id: ScheduleId,
  options: StatelessScheduleOptions = {}
): Effect.Effect<Schedule, ScheduleError> =>
  setScheduleState(store, id, "paused", options);

export const resumeSchedule = (
  store: ScheduleStoreService,
  id: ScheduleId,
  options: StatelessScheduleOptions = {}
): Effect.Effect<Schedule, ScheduleError> =>
  setScheduleState(store, id, "active", options);

export const unregisterSchedule = (
  store: ScheduleStoreService,
  id: ScheduleId,
  options: StatelessScheduleOptions = {}
): Effect.Effect<void, ScheduleError> => {
  const commit = resolveCommit(store, options);
  return Effect.gen(function* () {
    yield* requireSchedule(store, id);
    const now = options.now ?? (yield* Clock.currentTimeMillis);
    yield* commit(now, [{ scheduleId: id, type: "schedule.removed" }], {
      removed: [id],
    });
  });
};
