import { closeInstance, openInstance } from "@foundry/lib/instance-identity";
import {
  neverGone,
  type ProcessIdentity,
  portableProcess,
} from "@foundry/lib/process-identity";
import { Clock, Effect } from "effect";
import { firstDue, validateCadence, validatePolicies } from "./cadence";
import type { ScheduleDispatchService } from "./dispatch";
import {
  type Instant,
  type JobOutcome,
  type Occurrence,
  type OccurrenceId,
  type RegisterScheduleInput,
  type Schedule,
  type ScheduleCursor,
  type ScheduleError,
  type ScheduleId,
  ScheduleNotFoundError,
  type SchedulerOwner,
} from "./domain";
import {
  type Commit,
  DEFAULT_CLAIM_TTL_MS,
  makeEvaluator,
  makeStoreCommit,
  sameJson,
  settleCursor,
} from "./evaluator";
import type { ScheduleStoreService } from "./store/index";

const DEFAULT_MAX_OCCURRENCES = 100;

export interface StatelessScheduleOptions {
  readonly commit?: Commit;
  readonly nextEventId?: () => string;
  readonly now?: Instant;
}

export interface TriggerScheduleNowOptions extends StatelessScheduleOptions {
  readonly claimTtlMs?: number;
  readonly isOwnerGone?: (owner: ProcessIdentity) => boolean;
  readonly maxOccurrencesPerSchedule?: number;
  readonly owner?: SchedulerOwner;
}

export interface RecordSettlementOptions extends StatelessScheduleOptions {
  readonly maxOccurrencesPerSchedule?: number;
  readonly settledAt?: Instant;
}

const resolveCommit = (
  store: ScheduleStoreService,
  options: StatelessScheduleOptions
): Commit => options.commit ?? makeStoreCommit(store, options.nextEventId);

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

const retryingCursorConflicts = <A>(attempt: Effect.Effect<A, ScheduleError>) =>
  Effect.retry(attempt, {
    times: 3,
    while: (error) => error._tag === "CursorConflictError",
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

export const triggerScheduleNow = (
  store: ScheduleStoreService,
  dispatch: ScheduleDispatchService,
  id: ScheduleId,
  options: TriggerScheduleNowOptions = {}
): Effect.Effect<Occurrence, ScheduleError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const schedule = yield* requireSchedule(store, id);
      const self: SchedulerOwner =
        options.owner ??
        (yield* Effect.acquireRelease(
          Effect.sync(() => openInstance(portableProcess())),
          (instance) => Effect.sync(() => closeInstance(instance))
        ));
      const { triggerNow } = makeEvaluator({
        claimTtlMs: options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS,
        commit: resolveCommit(store, options),
        dispatch,
        isOwnerGone: options.isOwnerGone ?? neverGone,
        maxOccurrencesPerSchedule:
          options.maxOccurrencesPerSchedule ?? DEFAULT_MAX_OCCURRENCES,
        self,
        store,
      });
      const now = options.now ?? (yield* Clock.currentTimeMillis);
      const occurrence = yield* triggerNow(schedule, now);
      return occurrence ?? (yield* Effect.dieMessage("nothing was decided"));
    })
  );

export const recordSettlement = (
  store: ScheduleStoreService,
  occurrenceId: OccurrenceId,
  outcome: JobOutcome,
  options: RecordSettlementOptions = {}
): Effect.Effect<Occurrence | undefined, ScheduleError> => {
  const commit = resolveCommit(store, options);
  return retryingCursorConflicts(
    Effect.gen(function* () {
      const existing = yield* store.getOccurrence(occurrenceId);
      if (existing === undefined || existing.state.kind !== "dispatched") {
        return;
      }
      const settledAt =
        options.settledAt ?? options.now ?? (yield* Clock.currentTimeMillis);
      const settled: Occurrence = {
        ...existing,
        state: {
          jobId: existing.state.jobId,
          kind: "settled",
          outcome,
          settledAt,
        },
      };
      const [schedule, cursor] = yield* Effect.all([
        store.getSchedule(existing.scheduleId),
        store.getCursor(existing.scheduleId),
      ]);
      let activeJobId = cursor?.activeJobId;
      if (cursor !== undefined && cursor.activeJobId === existing.state.jobId) {
        const open = yield* store.listOccurrences({
          scheduleId: existing.scheduleId,
          state: "dispatched",
        });
        activeJobId = open
          .flatMap((occurrence) =>
            occurrence.id !== existing.id &&
            occurrence.state.kind === "dispatched"
              ? [occurrence.state.jobId]
              : []
          )
          .at(-1);
      }
      const nextCursor =
        cursor === undefined
          ? undefined
          : settleCursor(schedule, cursor, activeJobId, settledAt);
      yield* commit(
        settledAt,
        [{ occurrence: settled, type: "occurrence.settled" }],
        {
          ...(nextCursor === undefined ? {} : { cursors: [nextCursor] }),
          ...(nextCursor !== undefined && cursor !== undefined
            ? { expectedCursors: [cursor] }
            : {}),
          maxOccurrencesPerSchedule:
            options.maxOccurrencesPerSchedule ?? DEFAULT_MAX_OCCURRENCES,
          occurrences: [settled],
        }
      );
      return settled;
    })
  );
};
