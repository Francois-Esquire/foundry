import { sameInstance } from "@foundry/lib/instance-identity";
import { canonicalizeJson } from "@foundry/lib/json";
import { Effect, Layer, Ref } from "effect";
import {
  CursorConflictError,
  type Occurrence,
  type Schedule,
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

const claimable = (
  stored: Occurrence | undefined,
  replacing: Occurrence | undefined
) =>
  replacing === undefined
    ? stored === undefined
    : stored !== undefined &&
      canonicalizeJson(stored) === canonicalizeJson(replacing);

const conflictIn = (
  cursors: ReadonlyMap<string, ScheduleCursor>,
  write: ScheduleWrite
) =>
  (write.expectedCursors ?? []).find(
    (expected) =>
      canonicalizeJson(cursors.get(expected.scheduleId) ?? null) !==
      canonicalizeJson(expected)
  );

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
        claim: (occurrence, replacing) =>
          Ref.modify(records, (current) =>
            claimable(current.occurrences.get(occurrence.id), replacing)
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
              const conflict = conflictIn(current.cursors, write);
              return conflict === undefined
                ? [undefined, applied(current, write)]
                : [conflict, current];
            }),
            (conflict) =>
              conflict === undefined
                ? Effect.void
                : Effect.fail(
                    new CursorConflictError({ scheduleId: conflict.scheduleId })
                  )
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
        listOccurrences: (filter = {}) =>
          read((current) =>
            [...current.occurrences.values()].filter(
              (o) =>
                (filter.scheduleId === undefined ||
                  o.scheduleId === filter.scheduleId) &&
                (filter.state === undefined || o.state.kind === filter.state)
            )
          ),
        listSchedules: read((current) => [...current.schedules.values()]),
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
