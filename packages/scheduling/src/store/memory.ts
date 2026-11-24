import { Effect, Layer, Ref } from "effect";
import type { Occurrence, Schedule, ScheduleCursor } from "../domain";
import { ScheduleStore, type ScheduleStoreService } from "./index";

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
        claim: (occurrence) =>
          Ref.modify(records, (current) =>
            current.occurrences.has(occurrence.id)
              ? [false, current]
              : [
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
          ),
        commit: (write) =>
          Ref.update(records, (current) => {
            const removed = new Set(write.removed ?? []);
            return {
              cursors: upsert(
                without(current.cursors, (id) => removed.has(id)),
                write.cursors,
                (cursor) => cursor.scheduleId
              ),
              occurrences: upsert(
                without(current.occurrences, (_, o) =>
                  removed.has(o.scheduleId)
                ),
                write.occurrences,
                (o) => o.id
              ),
              schedules: upsert(
                without(current.schedules, (id) => removed.has(id)),
                write.schedules,
                (schedule) => schedule.id
              ),
            };
          }),
        getCursor: (id) => read((current) => current.cursors.get(id)),
        getOccurrence: (id) => read((current) => current.occurrences.get(id)),
        getSchedule: (id) => read((current) => current.schedules.get(id)),
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
      };
    }
  );

export const MemoryScheduleStore: Layer.Layer<ScheduleStore> = Layer.effect(
  ScheduleStore,
  makeMemoryScheduleStore
);
