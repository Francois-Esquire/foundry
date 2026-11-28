import {
  closeInstance,
  instanceGone,
  openInstance,
  sameInstance,
} from "@foundry/lib/instance-identity";
import { canonicalizeJson } from "@foundry/lib/json";
import {
  neverGone,
  type ProcessIdentity,
  portableProcess,
} from "@foundry/lib/process-identity";
import { Clock, Effect } from "effect";
import { dueOccurrences, nextDue } from "./cadence";
import type { ScheduleDispatchService } from "./dispatch";
import {
  type Instant,
  type Occurrence,
  occurrenceId,
  type Schedule,
  type ScheduleCursor,
  type ScheduleError,
  type ScheduleEvent,
  type ScheduleId,
  type SchedulerOwner,
  type SkipReason,
} from "./domain";
import type { ScheduleStoreService, ScheduleWrite } from "./store/index";

export type Fact = ScheduleEvent extends infer Event
  ? Event extends ScheduleEvent
    ? Omit<Event, "at" | "id">
    : never
  : never;

export type Commit = (
  now: Instant,
  facts: readonly Fact[],
  write: Omit<ScheduleWrite, "events">
) => Effect.Effect<void, ScheduleError>;

interface Progress {
  readonly contended?: boolean;
  readonly cursor: ScheduleCursor;
  readonly decided: readonly Occurrence[];
  readonly facts: readonly Fact[];
  readonly writes: readonly Occurrence[];
}

export interface Evaluation {
  readonly decided: readonly Occurrence[];
  readonly nextDueAt: Instant | null;
  readonly open: boolean;
}

export interface EvaluatorOptions {
  readonly claimTtlMs?: number;
  readonly commit: Commit;
  readonly dispatch: ScheduleDispatchService;
  readonly isOwnerGone: (owner: ProcessIdentity) => boolean;
  readonly maxOccurrencesPerSchedule: number;
  readonly self: SchedulerOwner;
  readonly store: ScheduleStoreService;
}

const SUPERSEDED = "superseded by next schedule occurrence";

const CURSOR_CONFLICT_RETRIES = 3;

const retryingConflicts = <A>(attempt: Effect.Effect<A, ScheduleError>) =>
  Effect.retry(attempt, {
    times: CURSOR_CONFLICT_RETRIES,
    while: (error) => error._tag === "CursorConflictError",
  });

export const sameJson = (one: unknown, other: unknown) =>
  canonicalizeJson(one) === canonicalizeJson(other);

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

const latestSettle = (settled: readonly Occurrence[]) =>
  settled.reduce<Instant | undefined>(
    (latest, occurrence) =>
      occurrence.state.kind === "settled"
        ? Math.max(
            latest ?? occurrence.state.settledAt,
            occurrence.state.settledAt
          )
        : latest,
    undefined
  );

export const makeStoreCommit =
  (store: ScheduleStoreService): Commit =>
  (at, facts, write) =>
    store.commit({
      ...write,
      events: facts.map(
        (fact): ScheduleEvent => ({
          ...fact,
          at,
          id: `ev-${crypto.randomUUID()}`,
        })
      ),
    });

const settleCursor = (
  schedule: Schedule | undefined,
  cursor: ScheduleCursor,
  activeJobId: string | undefined,
  settledAt: Instant | undefined
): ScheduleCursor => {
  const lastSettledAt =
    settledAt === undefined
      ? cursor.lastSettledAt
      : Math.max(cursor.lastSettledAt ?? settledAt, settledAt);
  const base = withActive(
    {
      ...cursor,
      ...(lastSettledAt === undefined ? {} : { lastSettledAt }),
    },
    activeJobId
  );
  return schedule?.cadence.kind === "delay" &&
    settledAt !== undefined &&
    base.activeJobId === undefined
    ? {
        ...base,
        nextDueAt: nextDue(schedule.cadence, lastSettledAt ?? settledAt),
      }
    : base;
};

export const makeEvaluator = ({
  claimTtlMs,
  commit,
  dispatch,
  isOwnerGone,
  maxOccurrencesPerSchedule,
  self,
  store,
}: EvaluatorOptions) => {
  const settledOf = (occurrence: Occurrence) => {
    if (occurrence.state.kind !== "dispatched") {
      return Effect.succeed(undefined);
    }
    const { jobId } = occurrence.state;
    return Effect.map(
      dispatch.status(jobId),
      (status): Occurrence | undefined =>
        status.kind === "open"
          ? undefined
          : {
              ...occurrence,
              state: {
                jobId,
                kind: "settled",
                outcome: status.outcome,
                settledAt: status.settledAt,
              },
            }
    );
  };

  const refresh = (schedule: Schedule, cursor: ScheduleCursor) =>
    Effect.gen(function* () {
      const open = yield* store.listOccurrences({
        scheduleId: cursor.scheduleId,
        state: "dispatched",
      });
      const checked = yield* Effect.forEach(open, (occurrence) =>
        Effect.map(settledOf(occurrence), (done) => ({
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
      const settledAt = latestSettle(settled);
      return {
        cursor: settleCursor(schedule, cursor, active, settledAt),
        decided: [],
        facts: settled.map((occurrence) => ({
          occurrence,
          type: "occurrence.settled" as const,
        })),
        writes: settled,
      } satisfies Progress;
    });

  type ClaimResult = "claimed" | "decided" | "held-by-peer";

  const validClaimTtlMs =
    claimTtlMs !== undefined && Number.isFinite(claimTtlMs) && claimTtlMs > 0
      ? claimTtlMs
      : undefined;

  const claimExpired = (
    lease: {
      readonly claimedAt: Instant;
      readonly expiresAt?: Instant;
      readonly owner: SchedulerOwner;
    },
    now: Instant
  ) =>
    lease.expiresAt === undefined
      ? validClaimTtlMs !== undefined &&
        lease.claimedAt + validClaimTtlMs <= now
      : lease.expiresAt <= now;

  const claimStale = (
    lease: {
      readonly claimedAt: Instant;
      readonly expiresAt?: Instant;
      readonly owner: SchedulerOwner;
    },
    now: Instant
  ) =>
    Effect.sync(
      () =>
        claimExpired(lease, now) || instanceGone(lease.owner, self, isOwnerGone)
    );

  const claimExisting = (
    occurrence: Occurrence,
    existing: Occurrence,
    exclusive: boolean,
    now: Instant
  ): Effect.Effect<ClaimResult, ScheduleError> =>
    Effect.gen(function* () {
      if (existing.state.kind !== "claimed") {
        return "decided";
      }
      const { owner } = existing.state.lease;
      if (sameInstance(owner, self)) {
        return "claimed";
      }
      if (!(yield* claimStale(existing.state.lease, now))) {
        return "held-by-peer";
      }
      return (yield* store.claim(occurrence, existing, exclusive))
        ? "claimed"
        : "held-by-peer";
    });

  const claimAroundPeer = (
    occurrence: Occurrence,
    now: Instant
  ): Effect.Effect<ClaimResult, ScheduleError> =>
    Effect.gen(function* () {
      const claimed = yield* store.listOccurrences({
        scheduleId: occurrence.scheduleId,
        state: "claimed",
      });
      for (const other of claimed) {
        if (other.id === occurrence.id || other.state.kind !== "claimed") {
          continue;
        }
        const { owner } = other.state.lease;
        if (!(yield* claimStale(other.state.lease, now))) {
          return "held-by-peer";
        }
        yield* store.releaseClaim(other.id, owner);
      }
      return (yield* store.claim(occurrence, undefined, true))
        ? "claimed"
        : "held-by-peer";
    });

  const claim = (
    occurrence: Occurrence,
    exclusive: boolean,
    now: Instant
  ): Effect.Effect<ClaimResult, ScheduleError> =>
    Effect.gen(function* () {
      if (yield* store.claim(occurrence, undefined, exclusive)) {
        return "claimed";
      }
      const existing = yield* store.getOccurrence(occurrence.id);
      if (existing !== undefined) {
        return yield* claimExisting(occurrence, existing, exclusive, now);
      }
      return exclusive
        ? yield* claimAroundPeer(occurrence, now)
        : "held-by-peer";
    });

  const dispatchDue = (
    schedule: Schedule,
    progress: Progress,
    scheduledFor: Instant,
    now: Instant,
    contendedBase?: Progress
  ) =>
    Effect.gen(function* () {
      const base = occurrenceAt(schedule.id, scheduledFor);
      const claimed: Occurrence = {
        ...base,
        state: {
          claimedAt: now,
          kind: "claimed",
          lease: {
            claimedAt: now,
            ...(validClaimTtlMs === undefined
              ? {}
              : { expiresAt: now + validClaimTtlMs }),
            owner: self,
          },
        },
      };
      const exclusive: boolean = schedule.overlap !== "allow";
      const cursor = { ...progress.cursor, lastScheduledFor: scheduledFor };
      const outcome = yield* claim(claimed, exclusive, now);
      if (outcome !== "claimed") {
        const taken = skipped(base, "already-claimed", now);
        if (outcome === "held-by-peer") {
          const kept = contendedBase ?? progress;
          return {
            ...record(kept, kept.cursor, taken, [skippedFact(taken)], false),
            contended: true,
          };
        }
        return record(progress, cursor, taken, [skippedFact(taken)], false);
      }
      const claimedFact: Fact = {
        occurrence: claimed,
        type: "occurrence.claimed",
      };
      let active = progress.cursor.activeJobId;
      if (exclusive && active === undefined) {
        active = (yield* refresh(schedule, progress.cursor)).cursor.activeJobId;
      }
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
      const { jobId } = yield* Effect.tapError(
        Effect.gen(function* () {
          if (active !== undefined && schedule.overlap === "cancel-previous") {
            yield* dispatch.cancel(active, SUPERSEDED);
          }
          return yield* dispatch.submit({
            idempotencyKey: base.id,
            scheduledFor,
            scheduleId: schedule.id,
            target: schedule.target,
          });
        }),
        () => Effect.ignore(store.releaseClaim(base.id, self))
      );
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

  const save = (
    stored: ScheduleCursor | undefined,
    before: ScheduleCursor,
    progress: Progress,
    now: Instant
  ) => {
    const cursorChanged = !sameJson(before, progress.cursor);
    return progress.writes.length === 0 &&
      progress.facts.length === 0 &&
      !cursorChanged
      ? Effect.void
      : commit(now, progress.facts, {
          ...(cursorChanged ? { cursors: [progress.cursor] } : {}),
          ...(cursorChanged && stored !== undefined
            ? { expectedCursors: [stored] }
            : {}),
          maxOccurrencesPerSchedule,
          occurrences: progress.writes,
        });
  };

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
        lastScheduledFor: due.toDispatch ?? due.skipped.at(-1),
        nextDueAt: due.nextDueAt,
      },
      decided: [...progress.decided, ...missed],
      facts: [...progress.facts, ...missed.map(skippedFact)],
      writes: [...progress.writes, ...missed],
    };
    if (due.toDispatch === null) {
      return Effect.succeed(advanced);
    }
    return dispatchDue(schedule, advanced, due.toDispatch, now, progress);
  };

  const evaluateOnce = (schedule: Schedule, now: Instant) =>
    Effect.gen(function* () {
      const cursor = yield* store.getCursor(schedule.id);
      if (cursor === undefined) {
        return {
          decided: [],
          nextDueAt: null,
          open: false,
        } satisfies Evaluation;
      }
      const refreshed: Progress = yield* refresh(schedule, cursor);
      const progress: Progress =
        schedule.state === "active"
          ? yield* advance(schedule, refreshed, now)
          : refreshed;
      yield* save(cursor, cursor, progress, now);
      return {
        decided: progress.decided,
        nextDueAt:
          schedule.state === "active" && !progress.contended
            ? progress.cursor.nextDueAt
            : null,
        open:
          progress.cursor.activeJobId !== undefined ||
          progress.contended === true ||
          (schedule.cadence.kind === "delay" &&
            progress.cursor.nextDueAt === null),
      } satisfies Evaluation;
    });

  const triggerNowOnce = (schedule: Schedule, now: Instant) =>
    Effect.gen(function* () {
      const stored = yield* store.getCursor(schedule.id);
      const cursor = stored ?? { nextDueAt: null, scheduleId: schedule.id };
      const progress = yield* dispatchDue(
        schedule,
        yield* refresh(schedule, cursor),
        now,
        now
      );
      yield* save(stored, cursor, progress, now);
      return progress.decided.at(-1);
    });

  const evaluate = (schedule: Schedule, now: Instant) =>
    retryingConflicts(evaluateOnce(schedule, now));

  const triggerNow = (schedule: Schedule, now: Instant) =>
    retryingConflicts(triggerNowOnce(schedule, now));

  return { evaluate, triggerNow };
};

export const DEFAULT_CLAIM_TTL_MS = 60_000;
const DEFAULT_MAX_OCCURRENCES = 100;
const DEFAULT_SETTLE_POLL_MS = 5000;

const earliest = (one: Instant | undefined, other: Instant | null) =>
  other === null ? one : Math.min(one ?? other, other);

export interface EvaluateDueSchedulesOptions {
  readonly claimTtlMs?: number;
  readonly dispatch: ScheduleDispatchService;
  readonly isOwnerGone?: (owner: ProcessIdentity) => boolean;
  readonly maxOccurrencesPerSchedule?: number;
  readonly now?: Instant;
  readonly owner?: SchedulerOwner;
  readonly settlePollMs?: number;
  readonly store: ScheduleStoreService;
}

export interface ScheduleEvaluationFailure {
  readonly error: ScheduleError;
  readonly scheduleId: ScheduleId;
}

export interface EvaluateDueSchedulesResult {
  readonly decided: readonly Occurrence[];
  readonly errors: readonly ScheduleEvaluationFailure[];
  readonly soonest: Instant | undefined;
}

export const evaluateDueSchedules = (
  options: EvaluateDueSchedulesOptions
): Effect.Effect<EvaluateDueSchedulesResult, ScheduleError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const self: SchedulerOwner =
        options.owner ??
        (yield* Effect.acquireRelease(
          Effect.sync(() => openInstance(portableProcess())),
          (instance) => Effect.sync(() => closeInstance(instance))
        ));
      const settlePollMs = options.settlePollMs ?? DEFAULT_SETTLE_POLL_MS;
      const commit = makeStoreCommit(options.store);
      const { evaluate } = makeEvaluator({
        claimTtlMs: options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS,
        commit,
        dispatch: options.dispatch,
        isOwnerGone: options.isOwnerGone ?? neverGone,
        maxOccurrencesPerSchedule:
          options.maxOccurrencesPerSchedule ?? DEFAULT_MAX_OCCURRENCES,
        self,
        store: options.store,
      });
      const now = options.now ?? (yield* Clock.currentTimeMillis);
      const candidates =
        options.store.listDueSchedules === undefined
          ? yield* options.store.listSchedules
          : yield* options.store.listDueSchedules(now);
      const decided: Occurrence[] = [];
      const errors: ScheduleEvaluationFailure[] = [];
      let soonest: Instant | undefined;
      for (const schedule of candidates) {
        const result = yield* evaluate(schedule, now).pipe(
          Effect.catchAll((error) => {
            errors.push({ error, scheduleId: schedule.id });
            return Effect.succeed<Evaluation>({
              decided: [],
              nextDueAt: now + settlePollMs,
              open: false,
            });
          })
        );
        decided.push(...result.decided);
        soonest = earliest(soonest, result.nextDueAt);
        if (result.open) {
          soonest = earliest(soonest, now + settlePollMs);
        }
      }
      if (
        options.store.listDueSchedules !== undefined &&
        options.store.nextDueAt !== undefined
      ) {
        soonest = earliest(soonest, (yield* options.store.nextDueAt) ?? null);
      }
      return { decided, errors, soonest };
    })
  );
