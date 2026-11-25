import { Effect, Layer, Ref } from "effect";
import {
  type ConcurrencyPool,
  type Job,
  type Run,
  type Suspension,
  WriteConflictError,
} from "../domain";
import { conflictOf } from "./conflict";
import { QueueStore, type QueueStoreService, type QueueWrite } from "./index";

interface Records {
  readonly jobs: ReadonlyMap<string, Job>;
  readonly pools: ReadonlyMap<string, ConcurrencyPool>;
  readonly runs: ReadonlyMap<string, Run>;
  readonly suspensions: ReadonlyMap<string, Suspension>;
  readonly watermark: number;
}

const upsert = <T>(
  current: ReadonlyMap<string, T>,
  values: readonly T[] | undefined,
  key: (value: T) => string
): ReadonlyMap<string, T> => {
  if (values === undefined || values.length === 0) {
    return current;
  }
  const next = new Map(current);
  for (const value of values) {
    next.set(key(value), value);
  }
  return next;
};

const without = <T>(
  current: ReadonlyMap<string, T>,
  ids: readonly string[] | undefined
): ReadonlyMap<string, T> => {
  if (ids === undefined || ids.length === 0) {
    return current;
  }
  const next = new Map(current);
  for (const id of ids) {
    next.delete(id);
  }
  return next;
};

const applied = (current: Records, write: QueueWrite): Records => ({
  jobs: without(
    upsert(current.jobs, write.jobs, (job) => job.id),
    write.deleteJobs
  ),
  pools: upsert(current.pools, write.pools, (pool) => pool.name),
  runs: without(
    upsert(current.runs, write.runs, (run) => run.id),
    write.deleteRuns
  ),
  suspensions: without(
    upsert(
      current.suspensions,
      write.suspensions,
      (suspension) => suspension.id
    ),
    write.deleteSuspensions
  ),
  watermark: current.watermark + 1,
});

export const makeMemoryQueueStore: Effect.Effect<QueueStoreService> =
  Effect.map(
    Ref.make<Records>({
      jobs: new Map(),
      pools: new Map(),
      runs: new Map(),
      suspensions: new Map(),
      watermark: 0,
    }),
    (records) => {
      const read = <T>(pick: (current: Records) => T) =>
        Effect.map(Ref.get(records), pick);
      return {
        commit: (write) =>
          Effect.flatMap(
            Ref.modify(records, (current) => {
              const conflict = conflictOf(write, {
                holderOf: (key) =>
                  [...current.jobs.values()].find(
                    (job) => job.policy.idempotencyKey === key
                  )?.id,
                runRevision: (id) => current.runs.get(id)?.revision,
                suspensionRevision: (id) =>
                  current.suspensions.get(id)?.revision,
              });
              return conflict === undefined
                ? [undefined, applied(current, write)]
                : [conflict, current];
            }),
            (conflict) =>
              conflict === undefined
                ? Effect.void
                : Effect.fail(new WriteConflictError({ id: conflict }))
          ),
        getJob: (id) => read((current) => current.jobs.get(id)),
        getRun: (id) => read((current) => current.runs.get(id)),
        getSuspension: (id) => read((current) => current.suspensions.get(id)),
        listJobs: (filter = {}) =>
          read((current) =>
            [...current.jobs.values()].filter(
              (job) =>
                (filter.state === undefined ||
                  job.state.kind === filter.state) &&
                (filter.idempotencyKey === undefined ||
                  job.policy.idempotencyKey === filter.idempotencyKey)
            )
          ),
        listPools: read((current) => [...current.pools.values()]),
        listRuns: (filter = {}) =>
          read((current) =>
            [...current.runs.values()].filter(
              (run) =>
                (filter.state === undefined ||
                  run.state.kind === filter.state) &&
                (filter.jobId === undefined || run.jobId === filter.jobId)
            )
          ),
        listSuspensions: (filter = {}) =>
          read((current) =>
            [...current.suspensions.values()].filter(
              (suspension) =>
                (filter.state === undefined ||
                  suspension.state.kind === filter.state) &&
                (filter.runId === undefined ||
                  suspension.runId === filter.runId)
            )
          ),
        watermark: read((current) => current.watermark),
      };
    }
  );

export const MemoryQueueStore: Layer.Layer<QueueStore> = Layer.effect(
  QueueStore,
  makeMemoryQueueStore
);
