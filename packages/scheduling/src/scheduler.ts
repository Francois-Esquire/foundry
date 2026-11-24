import { closeInstance, openInstance } from "@foundry/lib/instance-identity";
import {
  isGone,
  type ProcessIdentity,
  thisProcess,
} from "@foundry/lib/process-identity";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  PubSub,
  type Scope,
  Stream,
} from "effect";
import { firstDue, validateCadence, validatePolicies } from "./cadence";
import { ScheduleDispatch } from "./dispatch";
import {
  type Instant,
  type Occurrence,
  type RegisterScheduleInput,
  type Schedule,
  type ScheduleCursor,
  type ScheduleError,
  type ScheduleEvent,
  type ScheduleId,
  ScheduleNotFoundError,
} from "./domain";
import {
  type Commit,
  type Evaluation,
  makeEvaluator,
  sameJson,
} from "./evaluate";
import { ScheduleStore } from "./store/index";

export interface SchedulerOptions {
  readonly identity?: ProcessIdentity;
  readonly instanceId?: string;
  readonly isOwnerGone?: (owner: ProcessIdentity) => boolean;
  readonly maxOccurrencesPerSchedule?: number;
  readonly maxRetryDelayMs?: number;
  readonly retryDelayMs?: number;
  readonly settlePollMs?: number;
  readonly syncIntervalMs?: number;
}

export interface SchedulerService {
  readonly cursor: (
    id: ScheduleId
  ) => Effect.Effect<ScheduleCursor | undefined, ScheduleError>;
  readonly get: (
    id: ScheduleId
  ) => Effect.Effect<Schedule | undefined, ScheduleError>;
  readonly latestOccurrence: (
    id: ScheduleId
  ) => Effect.Effect<Occurrence | undefined, ScheduleError>;
  readonly list: Effect.Effect<readonly Schedule[], ScheduleError>;
  readonly pause: (id: ScheduleId) => Effect.Effect<Schedule, ScheduleError>;
  readonly register: (
    input: RegisterScheduleInput
  ) => Effect.Effect<Schedule, ScheduleError>;
  readonly resume: (id: ScheduleId) => Effect.Effect<Schedule, ScheduleError>;
  readonly subscribe: Effect.Effect<
    Stream.Stream<ScheduleEvent>,
    never,
    Scope.Scope
  >;
  readonly tick: Effect.Effect<readonly Occurrence[], ScheduleError>;
  readonly triggerNow: (
    id: ScheduleId
  ) => Effect.Effect<Occurrence, ScheduleError>;
  readonly unregister: (id: ScheduleId) => Effect.Effect<void, ScheduleError>;
}

const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_SETTLE_POLL_MS = 5000;
const DEFAULT_MAX_OCCURRENCES = 100;

const earliest = (one: Instant | undefined, other: Instant | null) =>
  other === null ? one : Math.min(one ?? other, other);

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
    const self = yield* Effect.acquireRelease(
      Effect.sync(() =>
        openInstance(options.identity ?? thisProcess(), options.instanceId)
      ),
      (instance) => Effect.sync(() => closeInstance(instance))
    );
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const maxRetryDelayMs =
      options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    const settlePollMs = options.settlePollMs ?? DEFAULT_SETTLE_POLL_MS;
    const syncIntervalMs =
      options.syncIntervalMs !== undefined &&
      Number.isFinite(options.syncIntervalMs) &&
      options.syncIntervalMs > 0
        ? options.syncIntervalMs
        : undefined;
    const failures = new Map<
      ScheduleId,
      { readonly count: number; readonly retryAt: Instant }
    >();

    const commit: Commit = (now, facts, write) =>
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

    const { evaluate, triggerNow: fireNow } = makeEvaluator({
      commit,
      dispatch,
      isOwnerGone: options.isOwnerGone ?? isGone,
      maxOccurrencesPerSchedule:
        options.maxOccurrencesPerSchedule ?? DEFAULT_MAX_OCCURRENCES,
      self,
      store,
    });

    const requireSchedule = (id: ScheduleId) =>
      Effect.flatMap(store.getSchedule(id), (schedule) =>
        schedule === undefined
          ? Effect.fail(new ScheduleNotFoundError({ id }))
          : Effect.succeed(schedule)
      );

    const backingOff = (id: ScheduleId, now: Instant) => {
      const retryAt = failures.get(id)?.retryAt;
      return retryAt !== undefined && retryAt > now ? retryAt : undefined;
    };

    type Recover = (
      error: ScheduleError,
      now: Instant,
      id: ScheduleId
    ) => Effect.Effect<Evaluation, ScheduleError>;

    const evaluateOne = (
      schedule: Schedule,
      now: Instant,
      recover: Recover,
      waitOutBackoff: boolean
    ): Effect.Effect<Evaluation, ScheduleError> => {
      const retryAt = waitOutBackoff ? backingOff(schedule.id, now) : undefined;
      if (retryAt !== undefined) {
        return Effect.succeed({ decided: [], nextDueAt: retryAt, open: false });
      }
      return evaluate(schedule, now).pipe(
        Effect.tap(() => Effect.sync(() => failures.delete(schedule.id))),
        Effect.catchAll((error) => recover(error, now, schedule.id))
      );
    };

    const evaluateAll = (recover: Recover, waitOutBackoff: boolean) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const decided: Occurrence[] = [];
        let soonest =
          syncIntervalMs === undefined ? undefined : now + syncIntervalMs;
        for (const schedule of yield* store.listSchedules) {
          const result = yield* evaluateOne(
            schedule,
            now,
            recover,
            waitOutBackoff
          );
          decided.push(...result.decided);
          soonest = earliest(soonest, result.nextDueAt);
          if (result.open) {
            soonest = earliest(soonest, now + settlePollMs);
          }
        }
        return { decided, soonest };
      });

    const retryAtAfterFailure = (id: ScheduleId, now: Instant) => {
      const count = (failures.get(id)?.count ?? 0) + 1;
      const retryAt =
        now + Math.min(retryDelayMs * 2 ** (count - 1), maxRetryDelayMs);
      failures.set(id, { count, retryAt });
      return retryAt;
    };

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

    const tolerate = (error: ScheduleError, now: Instant, id: ScheduleId) =>
      Effect.as(Effect.logWarning("schedule evaluation failed", error), {
        decided: [],
        nextDueAt: retryAtAfterFailure(id, now),
        open: false,
      });

    yield* Effect.gen(function* () {
      yield* wake.close;
      const { soonest } = yield* locked(evaluateAll(tolerate, true)).pipe(
        Effect.catchAll((error) =>
          Effect.zipRight(
            Effect.logWarning("schedule evaluation failed", error),
            Effect.map(Clock.currentTimeMillis, (now) => ({
              soonest: now + retryDelayMs,
            }))
          )
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
        const misfire = input.misfire ?? "run-once";
        const overlap = input.overlap ?? "skip";
        yield* validatePolicies(cadence, overlap, misfire);
        const now = yield* Clock.currentTimeMillis;
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
          schedules: [schedule],
        });
        failures.delete(input.id);
        return schedule;
      });

    const triggerNow = (id: ScheduleId) =>
      Effect.gen(function* () {
        const schedule = yield* requireSchedule(id);
        const now = yield* Clock.currentTimeMillis;
        const occurrence = yield* fireNow(schedule, now);
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
      get: store.getSchedule,
      latestOccurrence: store.latestOccurrence,
      list: store.listSchedules,
      pause: (id) => setState(id, "paused"),
      register: (input) => changed(register(input)),
      resume: (id) => setState(id, "active"),
      subscribe: Stream.fromPubSub(hub, { scoped: true }),
      tick: Effect.map(
        locked(evaluateAll((error) => Effect.fail(error), false)),
        (result) => result.decided
      ),
      triggerNow: (id) => changed(triggerNow(id)),
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
