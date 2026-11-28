import { sameInstance } from "@foundry/lib/instance-identity";
import { canonicalizeJson } from "@foundry/lib/json";
import { Effect, Layer, Ref } from "effect";
import {
  CursorConflictError,
  type Occurrence,
  type Schedule,
  ScheduleConflictError,
  type ScheduleCursor,
} from "../domain";
import {
  ScheduleStore,
  type ScheduleStoreService,
  type ScheduleWrite,
} from "./index";

interface Records {
  readonly cursors: ReadonlyMap<string, ScheduleCursor>;
  readonly occurrences: ReadonlyMap<string, Occurrence>;
  readonly schedules: ReadonlyMap<string, Schedule>;
}

const without = <T>(
  current: ReadonlyMap<string, T>,
  drop: (key: string, value: T) => boolean
) => new Map([...current].filter(([key, value]) => !drop(key, value)));

const upsert = <T>(
  current: ReadonlyMap<string, T>,
  values: readonly T[] | undefined,
  key: (value: T) => string
) =>
  new Map([
    ...current,
    ...(values ?? []).map((value) => [key(value), value] as const),
  ]);

const TERMINAL = new Set(["settled", "skipped"]);

const retained = (
  occurrences: ReadonlyMap<string, Occurrence>,
  write: ScheduleWrite
): ReadonlyMap<string, Occurrence> => {
  const keep = write.maxOccurrencesPerSchedule;
  if (keep === undefined) {
    return occurrences;
  }
  const touched = new Set((write.occurrences ?? []).map((o) => o.scheduleId));
  const dropped = new Set<string>(
    [...touched].flatMap((scheduleId) =>
      [...occurrences.values()]
        .filter(
          (o) => o.scheduleId === scheduleId && TERMINAL.has(o.state.kind)
        )
        .sort((one, other) => other.scheduledFor - one.scheduledFor)
        .slice(keep)
        .map((o) => o.id)
    )
  );
  return without(occurrences, (id) => dropped.has(id));
};

const hasOtherClaim = (
  occurrences: ReadonlyMap<string, Occurrence>,
  occurrence: Occurrence
) =>
  [...occurrences.values()].some(
    (other) =>
      other.scheduleId === occurrence.scheduleId &&
      other.id !== occurrence.id &&
      other.state.kind === "claimed"
  );

const claimable = (
  occurrences: ReadonlyMap<string, Occurrence>,
  occurrence: Occurrence,
  replacing: Occurrence | undefined,
  exclusive: boolean
) => {
  if (exclusive && hasOtherClaim(occurrences, occurrence)) {
    return false;
  }
  const stored = occurrences.get(occurrence.id);
  return replacing === undefined
    ? stored === undefined
    : stored !== undefined &&
        canonicalizeJson(stored) === canonicalizeJson(replacing);
};

const conflictIn = (
  current: Records,
  write: ScheduleWrite
): CursorConflictError | ScheduleConflictError | undefined => {
  const schedule = (write.expectedSchedules ?? []).find(
    (expected) =>
      canonicalizeJson(current.schedules.get(expected.id) ?? null) !==
      canonicalizeJson(expected)
  );
  if (schedule !== undefined) {
    return new ScheduleConflictError({ scheduleId: schedule.id });
  }
  const cursor = (write.expectedCursors ?? []).find(
    (expected) =>
      canonicalizeJson(current.cursors.get(expected.scheduleId) ?? null) !==
      canonicalizeJson(expected)
  );
  return cursor === undefined
    ? undefined
    : new CursorConflictError({ scheduleId: cursor.scheduleId });
};

const applied = (current: Records, write: ScheduleWrite): Records => {
  const removed = new Set(write.removed ?? []);
  return {
    cursors: upsert(
      without(current.cursors, (id) => removed.has(id)),
      write.cursors,
      (cursor) => cursor.scheduleId
    ),
    occurrences: retained(
      upsert(
        without(current.occurrences, (_, o) => removed.has(o.scheduleId)),
        write.occurrences,
        (o) => o.id
      ),
      write
    ),
    schedules: upsert(
      without(current.schedules, (id) => removed.has(id)),
      write.schedules,
      (schedule) => schedule.id
    ),
  };
};

export const makeMemoryScheduleStore: Effect.Effect<ScheduleStoreService> =
  Effect.map(
    Ref.make<Records>({
      cursors: new Map(),
      occurrences: new Map(),
      schedules: new Map(),
    }),
    (records) => {
      const read = <T>(pick: (current: Records) => T) =>
        Effect.map(Ref.get(records), pick);
      return {
        claim: (occurrence, replacing, exclusive = false) =>
          Ref.modify(records, (current) =>
            claimable(current.occurrences, occurrence, replacing, exclusive)
              ? [
                  true,
                  {
                    ...current,
                    occurrences: upsert(
                      current.occurrences,
                      [occurrence],
                      (o) => o.id
                    ),
                  },
                ]
              : [false, current]
          ),
        commit: (write) =>
          Effect.flatMap(
            Ref.modify(records, (current) => {
              const conflict = conflictIn(current, write);
              return conflict === undefined
                ? [undefined, applied(current, write)]
                : [conflict, current];
            }),
            (conflict) =>
              conflict === undefined ? Effect.void : Effect.fail(conflict)
          ),
        getCursor: (id) => read((current) => current.cursors.get(id)),
        getOccurrence: (id) => read((current) => current.occurrences.get(id)),
        getSchedule: (id) => read((current) => current.schedules.get(id)),
        latestOccurrence: (scheduleId) =>
          read((current) =>
            [...current.occurrences.values()]
              .filter((o) => o.scheduleId === scheduleId)
              .reduce<Occurrence | undefined>(
                (latest, o) =>
                  latest === undefined || o.scheduledFor > latest.scheduledFor
                    ? o
                    : latest,
                undefined
              )
          ),
        listDueSchedules: (now) =>
          read((current) => {
            const openSchedules = new Set<string>();
            for (const occurrence of current.occurrences.values()) {
              if (occurrence.state.kind === "dispatched") {
                openSchedules.add(occurrence.scheduleId);
              }
            }
            return [...current.cursors.values()]
              .filter((cursor) => {
                const schedule = current.schedules.get(cursor.scheduleId);
                if (schedule === undefined) {
                  return false;
                }
                return (
                  (schedule.state === "active" &&
                    cursor.nextDueAt !== null &&
                    cursor.nextDueAt <= now) ||
                  cursor.activeJobId !== undefined ||
                  openSchedules.has(cursor.scheduleId)
                );
              })
              .sort(
                (one, other) =>
                  (one.nextDueAt ?? Number.POSITIVE_INFINITY) -
                  (other.nextDueAt ?? Number.POSITIVE_INFINITY)
              )
              .flatMap((cursor) => {
                const schedule = current.schedules.get(cursor.scheduleId);
                return schedule === undefined ? [] : [schedule];
              });
          }),
        listOccurrences: (filter = {}) =>
          read((current) =>
            [...current.occurrences.values()]
              .filter(
                (o) =>
                  (filter.scheduleId === undefined ||
                    o.scheduleId === filter.scheduleId) &&
                  (filter.state === undefined || o.state.kind === filter.state)
              )
              .sort((one, other) => one.scheduledFor - other.scheduledFor)
          ),
        listSchedules: read((current) => [...current.schedules.values()]),
        nextDueAt: read((current) => {
          let soonest: number | undefined;
          for (const cursor of current.cursors.values()) {
            const schedule = current.schedules.get(cursor.scheduleId);
            if (schedule?.state === "active" && cursor.nextDueAt !== null) {
              soonest =
                soonest === undefined
                  ? cursor.nextDueAt
                  : Math.min(soonest, cursor.nextDueAt);
            }
          }
          return soonest;
        }),
        releaseClaim: (id, owner) =>
          Ref.update(records, (current) => {
            const stored = current.occurrences.get(id);
            return stored?.state.kind === "claimed" &&
              sameInstance(stored.state.lease.owner, owner)
              ? {
                  ...current,
                  occurrences: without(
                    current.occurrences,
                    (key) => key === id
                  ),
                }
              : current;
          }),
      };
    }
  );

export const MemoryScheduleStore: Layer.Layer<ScheduleStore> = Layer.effect(
  ScheduleStore,
  makeMemoryScheduleStore
);
