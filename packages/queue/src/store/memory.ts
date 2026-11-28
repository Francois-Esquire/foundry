import { Effect, Layer, Ref } from "effect";
import {
  type ConcurrencyPool,
  type Job,
  type Run,
  type RunFilter,
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
        capabilities: { watermark: true },
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
          read((current) => {
            const matched = [...current.runs.values()].filter((run) =>
              matchesRunFilter(run, filter)
            );
            sortRuns(matched, filter.orderBy);
            return filter.limit === undefined
              ? matched
              : matched.slice(0, Math.max(0, filter.limit));
          }),
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

const matchesRunFilter = (run: Run, filter: RunFilter): boolean => {
  if (filter.state !== undefined && run.state.kind !== filter.state) {
    return false;
  }
  if (filter.jobId !== undefined && run.jobId !== filter.jobId) {
    return false;
  }
  if (filter.pool !== undefined && run.pool !== filter.pool) {
    return false;
  }
  if (
    filter.availableBefore !== undefined &&
    (run.state.kind !== "queued" ||
      run.state.availableAt > filter.availableBefore)
  ) {
    return false;
  }
  if (
    filter.leaseExpiredBefore !== undefined &&
    (run.state.kind !== "running" ||
      run.state.lease.expiresAt === undefined ||
      run.state.lease.expiresAt > filter.leaseExpiredBefore)
  ) {
    return false;
  }
  if (filter.orderBy === "availableAt" && run.state.kind !== "queued") {
    return false;
  }
  if (
    filter.orderBy === "leaseExpiresAt" &&
    (run.state.kind !== "running" || run.state.lease.expiresAt === undefined)
  ) {
    return false;
  }
  return true;
};

const runOrderKey = (
  run: Run,
  orderBy: NonNullable<RunFilter["orderBy"]>
): number => {
  if (orderBy === "availableAt") {
    return run.state.kind === "queued"
      ? run.state.availableAt
      : Number.POSITIVE_INFINITY;
  }
  return run.state.kind === "running"
    ? (run.state.lease.expiresAt ?? Number.POSITIVE_INFINITY)
    : Number.POSITIVE_INFINITY;
};

const compareIds = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

const sortRuns = (runs: Run[], orderBy: RunFilter["orderBy"]): void => {
  if (orderBy === undefined) {
    return;
  }
  runs.sort((a, b) => {
    const diff = runOrderKey(a, orderBy) - runOrderKey(b, orderBy);
    return diff === 0 ? compareIds(a.id, b.id) : diff;
  });
};

export const MemoryQueueStore: Layer.Layer<QueueStore> = Layer.effect(
  QueueStore,
  makeMemoryQueueStore
);
