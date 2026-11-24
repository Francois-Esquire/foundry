import { Effect, Layer, Ref } from "effect";
import type { ConcurrencyPool, Job, Run, Wait } from "../domain";
import { QueueStore, type QueueStoreService } from "./index";

interface Records {
  readonly jobs: ReadonlyMap<string, Job>;
  readonly pools: ReadonlyMap<string, ConcurrencyPool>;
  readonly runs: ReadonlyMap<string, Run>;
  readonly waits: ReadonlyMap<string, Wait>;
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

export const makeMemoryQueueStore: Effect.Effect<QueueStoreService> =
  Effect.map(
    Ref.make<Records>({
      jobs: new Map(),
      pools: new Map(),
      runs: new Map(),
      waits: new Map(),
    }),
    (records) => {
      const read = <T>(pick: (current: Records) => T) =>
        Effect.map(Ref.get(records), pick);
      return {
        commit: (write) =>
          Ref.update(records, (current) => ({
            jobs: upsert(current.jobs, write.jobs, (job) => job.id),
            pools: upsert(current.pools, write.pools, (pool) => pool.name),
            runs: upsert(current.runs, write.runs, (run) => run.id),
            waits: upsert(current.waits, write.waits, (wait) => wait.id),
          })),
        getJob: (id) => read((current) => current.jobs.get(id)),
        getRun: (id) => read((current) => current.runs.get(id)),
        getWait: (id) => read((current) => current.waits.get(id)),
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
        listWaits: (filter = {}) =>
          read((current) =>
            [...current.waits.values()].filter(
              (wait) =>
                (filter.state === undefined ||
                  wait.state.kind === filter.state) &&
                (filter.runId === undefined || wait.runId === filter.runId)
            )
          ),
      };
    }
  );

export const MemoryQueueStore: Layer.Layer<QueueStore> = Layer.effect(
  QueueStore,
  makeMemoryQueueStore
);
