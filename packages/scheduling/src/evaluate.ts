import { canonicalizeJson } from "@foundry/lib/json";
import {
  type ProcessIdentity,
  sameProcess,
} from "@foundry/lib/process-identity";
import { Effect } from "effect";
import { dueOccurrences } from "./cadence";
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
  readonly commit: Commit;
  readonly dispatch: ScheduleDispatchService;
  readonly isOwnerGone: (owner: ProcessIdentity) => boolean;
  readonly self: ProcessIdentity;
  readonly store: ScheduleStoreService;
}

const SUPERSEDED = "superseded by next schedule occurrence";

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

export const makeEvaluator = ({
  commit,
  dispatch,
  isOwnerGone,
  self,
  store,
}: EvaluatorOptions) => {
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
      if (existing?.state.kind !== "claimed") {
        return false;
      }
      const { owner } = existing.state.lease;
      if (sameProcess(owner, self)) {
        return true;
      }
      return (
        (yield* Effect.sync(() => isOwnerGone(owner))) &&
        (yield* store.claim(occurrence, existing))
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
    sameJson(before, progress.cursor)
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
        return {
          decided: [],
          nextDueAt: null,
          open: false,
        } satisfies Evaluation;
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
        open: progress.cursor.activeJobId !== undefined,
      } satisfies Evaluation;
    });

  const triggerNow = (schedule: Schedule, now: Instant) =>
    Effect.gen(function* () {
      const cursor = (yield* store.getCursor(schedule.id)) ?? {
        nextDueAt: null,
        scheduleId: schedule.id,
      };
      const progress = yield* fire(
        schedule,
        yield* refresh(cursor, now),
        now,
        now
      );
      yield* save(cursor, progress, now);
      return progress.decided.at(-1);
    });

  return { evaluate, triggerNow };
};
