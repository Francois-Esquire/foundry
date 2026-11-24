import {
  type ProcessIdentity,
  sameProcess,
  thisProcess,
} from "@foundry/lib/process-identity";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  PubSub,
  Stream,
} from "effect";
import { dueOccurrences, firstDue, validateCadence } from "./cadence";
import { ScheduleDispatch } from "./dispatch";
import {
  type Instant,
  type Occurrence,
  occurrenceId,
  type RegisterScheduleInput,
  type Schedule,
  type ScheduleCursor,
  type ScheduleError,
  type ScheduleEvent,
  type ScheduleId,
  ScheduleNotFoundError,
  type SkipReason,
} from "./domain";
import { ScheduleStore } from "./store/index";

export interface SchedulerOptions {
  readonly identity?: ProcessIdentity;
  readonly retryDelayMs?: number;
}

export interface SchedulerService {
  readonly cursor: (
    id: ScheduleId
  ) => Effect.Effect<ScheduleCursor | undefined, ScheduleError>;
  readonly events: Stream.Stream<ScheduleEvent>;
  readonly get: (
    id: ScheduleId
  ) => Effect.Effect<Schedule | undefined, ScheduleError>;
  readonly list: Effect.Effect<readonly Schedule[], ScheduleError>;
  readonly pause: (id: ScheduleId) => Effect.Effect<Schedule, ScheduleError>;
  readonly register: (
    input: RegisterScheduleInput
  ) => Effect.Effect<Schedule, ScheduleError>;
  readonly resume: (id: ScheduleId) => Effect.Effect<Schedule, ScheduleError>;
  readonly tick: Effect.Effect<readonly Occurrence[], ScheduleError>;
  readonly triggerNow: (
    id: ScheduleId
  ) => Effect.Effect<Occurrence, ScheduleError>;
  readonly unregister: (id: ScheduleId) => Effect.Effect<void, ScheduleError>;
}

type Fact = ScheduleEvent extends infer Event
  ? Event extends ScheduleEvent
    ? Omit<Event, "at" | "id">
    : never
  : never;

interface Progress {
  readonly cursor: ScheduleCursor;
  readonly decided: readonly Occurrence[];
  readonly facts: readonly Fact[];
  readonly writes: readonly Occurrence[];
}

interface Evaluation {
  readonly decided: readonly Occurrence[];
  readonly nextDueAt: Instant | null;
}

const SUPERSEDED = "superseded by next schedule occurrence";
const DEFAULT_RETRY_DELAY_MS = 1000;

const withActive = (
  cursor: ScheduleCursor,
  jobId: string | undefined
): ScheduleCursor => {
  const { activeJobId: _previous, ...rest } = cursor;
  return jobId === undefined ? rest : { ...rest, activeJobId: jobId };
};

const skipped = (
  occurrence: Omit<Occurrence, "state">,
  reason: SkipReason,
  at: Instant
): Occurrence => ({ ...occurrence, state: { at, kind: "skipped", reason } });

const skippedFact = (occurrence: Occurrence): Fact => ({
  occurrence,
  type: "occurrence.skipped",
});

const record = (
  progress: Progress,
  cursor: ScheduleCursor,
  occurrence: Occurrence,
  facts: readonly Fact[],
  persist: boolean
): Progress => ({
  cursor,
  decided: [...progress.decided, occurrence],
  facts: [...progress.facts, ...facts],
  writes: persist ? [...progress.writes, occurrence] : progress.writes,
});

const occurrenceAt = (scheduleId: ScheduleId, scheduledFor: Instant) => ({
  id: occurrenceId(scheduleId, scheduledFor),
  scheduledFor,
  scheduleId,
});

const makeScheduler = (options: SchedulerOptions) =>
  Effect.gen(function* () {
    const store = yield* ScheduleStore;
    const dispatch = yield* ScheduleDispatch;
    const hub = yield* Effect.acquireRelease(
      PubSub.unbounded<ScheduleEvent>(),
      PubSub.shutdown
    );
    const lock = yield* Effect.makeSemaphore(1);
    const wake = yield* Effect.makeLatch(false);
    const self = options.identity ?? thisProcess();
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

    const commit = (
      now: Instant,
      facts: readonly Fact[],
      write: {
        readonly cursors?: readonly ScheduleCursor[];
        readonly occurrences?: readonly Occurrence[];
        readonly removed?: readonly ScheduleId[];
        readonly schedules?: readonly Schedule[];
      }
    ) =>
      Effect.gen(function* () {
        const events = facts.map(
          (fact): ScheduleEvent => ({
            ...fact,
            at: now,
            id: `ev-${crypto.randomUUID()}`,
          })
        );
        yield* store.commit({ ...write, events });
        yield* PubSub.publishAll(hub, events);
      }).pipe(Effect.uninterruptible);

    const requireSchedule = (id: ScheduleId) =>
      Effect.flatMap(store.getSchedule(id), (schedule) =>
        schedule === undefined
          ? Effect.fail(new ScheduleNotFoundError({ id }))
          : Effect.succeed(schedule)
      );

    const settledOf = (occurrence: Occurrence, now: Instant) => {
      if (occurrence.state.kind !== "dispatched") {
        return Effect.succeed(undefined);
      }
      const { jobId } = occurrence.state;
      return Effect.map(
        dispatch.status(jobId),
        (status): Occurrence | undefined =>
          status === "open"
            ? undefined
            : {
                ...occurrence,
                state: {
                  jobId,
                  kind: "settled",
                  outcome: status,
                  settledAt: now,
                },
              }
      );
    };

    const refresh = (cursor: ScheduleCursor, now: Instant) =>
      Effect.gen(function* () {
        const open = yield* store.listOccurrences({
          scheduleId: cursor.scheduleId,
          state: "dispatched",
        });
        const checked = yield* Effect.forEach(open, (occurrence) =>
          Effect.map(settledOf(occurrence, now), (done) => ({
            done,
            occurrence,
          }))
        );
        const settled = checked.flatMap(({ done }) => (done ? [done] : []));
        const active = checked
          .flatMap(({ done, occurrence }) =>
            done === undefined && occurrence.state.kind === "dispatched"
              ? [occurrence.state.jobId]
              : []
          )
          .at(-1);
        const lastSettledAt = settled.length > 0 ? now : cursor.lastSettledAt;
        return {
          cursor: withActive(
            {
              ...cursor,
              ...(lastSettledAt === undefined ? {} : { lastSettledAt }),
            },
            active
          ),
          decided: [],
          facts: settled.map((occurrence) => ({
            occurrence,
            type: "occurrence.settled" as const,
          })),
          writes: settled,
        } satisfies Progress;
      });

    const claim = (occurrence: Occurrence) =>
      Effect.gen(function* () {
        if (yield* store.claim(occurrence)) {
          return true;
        }
        const existing = yield* store.getOccurrence(occurrence.id);
        return (
          existing?.state.kind === "claimed" &&
          sameProcess(existing.state.lease.owner, self)
        );
      });

    const fire = (
      schedule: Schedule,
      progress: Progress,
      scheduledFor: Instant,
      now: Instant
    ) =>
      Effect.gen(function* () {
        const base = occurrenceAt(schedule.id, scheduledFor);
        const claimed: Occurrence = {
          ...base,
          state: {
            claimedAt: now,
            kind: "claimed",
            lease: { claimedAt: now, owner: self },
          },
        };
        const cursor = { ...progress.cursor, lastScheduledFor: scheduledFor };
        if (!(yield* claim(claimed))) {
          const taken = skipped(base, "already-claimed", now);
          return record(progress, cursor, taken, [skippedFact(taken)], false);
        }
        const claimedFact: Fact = {
          occurrence: claimed,
          type: "occurrence.claimed",
        };
        const active = progress.cursor.activeJobId;
        if (active !== undefined && schedule.overlap === "skip") {
          const overlapped = skipped(base, "overlap", now);
          return record(
            progress,
            cursor,
            overlapped,
            [claimedFact, skippedFact(overlapped)],
            true
          );
        }
        if (active !== undefined && schedule.overlap === "cancel-previous") {
          yield* dispatch.cancel(active, SUPERSEDED);
        }
        const { jobId } = yield* dispatch.submit({
          idempotencyKey: base.id,
          scheduledFor,
          scheduleId: schedule.id,
          target: schedule.target,
        });
        const dispatched: Occurrence = {
          ...base,
          state: { dispatchedAt: now, jobId, kind: "dispatched" },
        };
        return record(
          progress,
          withActive(cursor, jobId),
          dispatched,
          [
            claimedFact,
            { occurrence: dispatched, type: "occurrence.dispatched" },
          ],
          true
        );
      });

    const save = (before: ScheduleCursor, progress: Progress, now: Instant) =>
      progress.writes.length === 0 &&
      progress.facts.length === 0 &&
      JSON.stringify(before) === JSON.stringify(progress.cursor)
        ? Effect.void
        : commit(now, progress.facts, {
            cursors: [progress.cursor],
            occurrences: progress.writes,
          });

    const advance = (
      schedule: Schedule,
      progress: Progress,
      now: Instant
    ): Effect.Effect<Progress, ScheduleError> => {
      const { nextDueAt } = progress.cursor;
      if (nextDueAt === null || now < nextDueAt) {
        return Effect.succeed(progress);
      }
      const due = dueOccurrences(
        schedule.cadence,
        nextDueAt,
        now,
        schedule.misfire
      );
      const missed = due.skipped.map((at) =>
        skipped(occurrenceAt(schedule.id, at), "misfire", now)
      );
      const advanced: Progress = {
        cursor: {
          ...progress.cursor,
          lastScheduledFor: due.toFire ?? due.skipped.at(-1),
          nextDueAt: due.nextDueAt,
        },
        decided: [...progress.decided, ...missed],
        facts: [...progress.facts, ...missed.map(skippedFact)],
        writes: [...progress.writes, ...missed],
      };
      return due.toFire === null
        ? Effect.succeed(advanced)
        : fire(schedule, advanced, due.toFire, now);
    };

    const evaluate = (schedule: Schedule, now: Instant) =>
      Effect.gen(function* () {
        const cursor = yield* store.getCursor(schedule.id);
        if (cursor === undefined) {
          return { decided: [], nextDueAt: null } satisfies Evaluation;
        }
        const progress = yield* advance(
          schedule,
          yield* refresh(cursor, now),
          now
        );
        yield* save(cursor, progress, now);
        return {
          decided: progress.decided,
          nextDueAt: progress.cursor.nextDueAt,
        } satisfies Evaluation;
      });

    const evaluateAll = (
      recover: (
        error: ScheduleError,
        now: Instant
      ) => Effect.Effect<Evaluation, ScheduleError>
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const decided: Occurrence[] = [];
        let soonest: Instant | undefined;
        for (const schedule of yield* store.listSchedules) {
          if (schedule.state !== "active") {
            continue;
          }
          const result = yield* evaluate(schedule, now).pipe(
            Effect.catchAll((error) => recover(error, now))
          );
          decided.push(...result.decided);
          if (result.nextDueAt !== null) {
            soonest = Math.min(soonest ?? result.nextDueAt, result.nextDueAt);
          }
        }
        return { decided, soonest };
      });

    const locked = lock.withPermits(1);

    const nap = (soonest: Instant | undefined) =>
      Effect.gen(function* () {
        if (soonest === undefined) {
          return yield* wake.await;
        }
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.race(
          wake.await,
          Effect.sleep(Duration.millis(Math.max(0, soonest - now)))
        );
      });

    const tolerate = (error: ScheduleError, now: Instant) =>
      Effect.as(Effect.logWarning("schedule evaluation failed", error), {
        decided: [],
        nextDueAt: now + retryDelayMs,
      });

    yield* Effect.gen(function* () {
      yield* wake.close;
      const { soonest } = yield* locked(evaluateAll(tolerate)).pipe(
        Effect.catchAll((error) =>
          Effect.as(Effect.logWarning("schedule evaluation failed", error), {
            soonest: undefined,
          })
        )
      );
      yield* nap(soonest);
    }).pipe(Effect.forever, Effect.forkScoped);

    const changed = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.zipLeft(locked(effect), wake.open);

    const setState = (id: ScheduleId, state: Schedule["state"]) =>
      changed(
        Effect.gen(function* () {
          const schedule = { ...(yield* requireSchedule(id)), state };
          const now = yield* Clock.currentTimeMillis;
          yield* commit(
            now,
            [
              {
                schedule,
                type:
                  state === "paused" ? "schedule.paused" : "schedule.resumed",
              },
            ],
            { schedules: [schedule] }
          );
          return schedule;
        })
      );

    const register = (input: RegisterScheduleInput) =>
      Effect.gen(function* () {
        const cadence = yield* validateCadence(input.cadence);
        const now = yield* Clock.currentTimeMillis;
        const existing = yield* store.getSchedule(input.id);
        const previous = yield* store.getCursor(input.id);
        const schedule: Schedule = {
          cadence,
          createdAt: existing?.createdAt ?? now,
          id: input.id,
          misfire: input.misfire ?? "run-once",
          overlap: input.overlap ?? "skip",
          state: input.state ?? existing?.state ?? "active",
          target: input.target,
        };
        const sameCadence =
          existing !== undefined &&
          JSON.stringify(existing.cadence) === JSON.stringify(cadence);
        const cursor: ScheduleCursor =
          sameCadence && previous !== undefined
            ? previous
            : {
                ...previous,
                nextDueAt: firstDue(cadence, now),
                scheduleId: input.id,
              };
        yield* commit(now, [{ schedule, type: "schedule.registered" }], {
          cursors: [cursor],
          schedules: [schedule],
        });
        return schedule;
      });

    const triggerNow = (id: ScheduleId) =>
      Effect.gen(function* () {
        const schedule = yield* requireSchedule(id);
        const now = yield* Clock.currentTimeMillis;
        const cursor = (yield* store.getCursor(id)) ?? {
          nextDueAt: null,
          scheduleId: id,
        };
        const progress = yield* fire(
          schedule,
          yield* refresh(cursor, now),
          now,
          now
        );
        yield* save(cursor, progress, now);
        const [occurrence] = progress.decided.slice(-1);
        return occurrence ?? (yield* Effect.dieMessage("nothing was decided"));
      });

    const unregister = (id: ScheduleId) =>
      Effect.gen(function* () {
        yield* requireSchedule(id);
        const now = yield* Clock.currentTimeMillis;
        yield* commit(now, [{ scheduleId: id, type: "schedule.removed" }], {
          removed: [id],
        });
      });

    return Scheduler.of({
      cursor: store.getCursor,
      events: Stream.fromPubSub(hub),
      get: store.getSchedule,
      list: store.listSchedules,
      pause: (id) => setState(id, "paused"),
      register: (input) => changed(register(input)),
      resume: (id) => setState(id, "active"),
      tick: Effect.map(
        locked(evaluateAll((error) => Effect.fail(error))),
        (result) => result.decided
      ),
      triggerNow: (id) => locked(triggerNow(id)),
      unregister: (id) => changed(unregister(id)),
    });
  });

export class Scheduler extends Context.Tag("@foundry/scheduling/Scheduler")<
  Scheduler,
  SchedulerService
>() {
  static readonly layer = (
    options: SchedulerOptions = {}
  ): Layer.Layer<Scheduler, never, ScheduleDispatch | ScheduleStore> =>
    Layer.scoped(Scheduler, makeScheduler(options));
}
