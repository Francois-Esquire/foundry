import {
  resolveMaxParameters,
  rowBatches,
  type SqliteDatabase,
  type SqliteTransaction,
} from "@foundry/lib/sqlite";
import { Turns } from "@foundry/lib/turns";
import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  lte,
  type SQL,
  sql,
} from "drizzle-orm";
import type {
  SQLiteColumn,
  SQLiteTable,
  SQLiteUpdateSetSource,
} from "drizzle-orm/sqlite-core";
import { Effect, Layer } from "effect";
import {
  type ConcurrencyPool,
  type Job,
  type JobId,
  type Run,
  type RunFilter,
  StoreError,
  type Suspension,
  WriteConflictError,
} from "../domain";
import { conflictOf, type StoredRevisions } from "./conflict";
import { QueueStore, type QueueStoreService, type QueueWrite } from "./index";
import {
  queueJobs,
  queuePools,
  queueRuns,
  queueSuspensions,
  queueWatermarks,
} from "./tables";

export type QueueDatabase = SqliteDatabase;

export type QueueTransaction = SqliteTransaction;

export interface SqliteQueueStoreOptions {
  readonly database: QueueDatabase;
  readonly maxParameters?: number;
  readonly onCommit?: (
    transaction: QueueTransaction,
    write: QueueWrite
  ) => Promise<void>;
  readonly scope: string;
  readonly watermark?: boolean;
}

const REENTRY =
  "SqliteQueueStore was called from inside its own transaction or onCommit hook; use the transaction passed to onCommit instead";

const DEFAULT_BATCH_PARAMETERS = 500;

const upsert = async <Table extends SQLiteTable>(
  transaction: QueueTransaction,
  table: Table,
  target: readonly SQLiteColumn[],
  rows: readonly Table["$inferInsert"][],
  update: readonly (keyof Table["$inferInsert"] & string)[],
  maxParameters: number
) => {
  const columns: Record<string, SQLiteColumn> = getTableColumns(table);
  const set = Object.fromEntries(
    update.map((key) => [
      key,
      sql.raw(`excluded."${columns[key]?.name ?? key}"`),
    ])
  ) as SQLiteUpdateSetSource<Table>;
  for (const batch of rowBatches(
    rows,
    Object.keys(columns).length,
    maxParameters
  )) {
    await transaction
      .insert(table)
      .values(batch)
      .onConflictDoUpdate({ set, target: [...target] });
  }
};

const writeRecords = async (
  transaction: QueueTransaction,
  scope: string,
  write: QueueWrite,
  maxParameters: number
) => {
  await upsert(
    transaction,
    queueJobs,
    [queueJobs.scope, queueJobs.id],
    (write.jobs ?? []).map((job) => ({
      body: job,
      id: job.id,
      idempotencyKey: job.policy.idempotencyKey ?? null,
      scope,
      state: job.state.kind,
    })),
    ["body", "idempotencyKey", "state"],
    maxParameters
  );
  await upsert(
    transaction,
    queueRuns,
    [queueRuns.scope, queueRuns.id],
    (write.runs ?? []).map((run) => ({
      availableAt: run.state.kind === "queued" ? run.state.availableAt : null,
      body: run,
      id: run.id,
      jobId: run.jobId,
      leaseExpiresAt:
        run.state.kind === "running"
          ? (run.state.lease.expiresAt ?? null)
          : null,
      pool: run.pool,
      scope,
      state: run.state.kind,
    })),
    ["availableAt", "body", "leaseExpiresAt", "pool", "state"],
    maxParameters
  );
  await upsert(
    transaction,
    queueSuspensions,
    [queueSuspensions.scope, queueSuspensions.id],
    (write.suspensions ?? []).map((suspension) => ({
      body: suspension,
      id: suspension.id,
      runId: suspension.runId,
      scope,
      state: suspension.state.kind,
    })),
    ["body", "state"],
    maxParameters
  );
  await upsert(
    transaction,
    queuePools,
    [queuePools.scope, queuePools.name],
    (write.pools ?? []).map((pool) => ({
      limit: Number.isFinite(pool.limit) ? pool.limit : null,
      name: pool.name,
      scope,
      state: pool.state,
    })),
    ["limit", "state"],
    maxParameters
  );
};

const remove = async (
  transaction: QueueTransaction,
  table: typeof queueJobs | typeof queueRuns | typeof queueSuspensions,
  column: SQLiteColumn,
  scope: string,
  ids: readonly string[] | undefined,
  maxParameters: number
) => {
  for (const batch of rowBatches(ids ?? [], 1, maxParameters, 1)) {
    await transaction
      .delete(table)
      .where(and(eq(table.scope, scope), inArray(column, batch)));
  }
};

const deleteRecords = async (
  transaction: QueueTransaction,
  scope: string,
  write: QueueWrite,
  maxParameters: number
) => {
  await remove(
    transaction,
    queueSuspensions,
    queueSuspensions.id,
    scope,
    write.deleteSuspensions,
    maxParameters
  );
  await remove(
    transaction,
    queueRuns,
    queueRuns.id,
    scope,
    write.deleteRuns,
    maxParameters
  );
  await remove(
    transaction,
    queueJobs,
    queueJobs.id,
    scope,
    write.deleteJobs,
    maxParameters
  );
};

const raiseWatermark = (transaction: QueueTransaction, scope: string) =>
  transaction
    .insert(queueWatermarks)
    .values({ scope, value: 1 })
    .onConflictDoUpdate({
      set: { value: sql`${queueWatermarks.value} + 1` },
      target: queueWatermarks.scope,
    });

const revisionsIn = async (
  transaction: QueueTransaction,
  table: typeof queueRuns | typeof queueSuspensions,
  scope: string,
  ids: readonly string[],
  maxParameters: number
) => {
  const found = new Map<string, number>();
  const column: SQLiteColumn = table.id;
  for (const batch of rowBatches(ids, 1, maxParameters, 1)) {
    const rows = await transaction
      .select({ body: table.body, id: table.id })
      .from(table)
      .where(and(eq(table.scope, scope), inArray(column, batch)));
    for (const row of rows) {
      found.set(row.id, row.body.revision);
    }
  }
  return found;
};

const holdersIn = async (
  transaction: QueueTransaction,
  scope: string,
  keys: readonly string[],
  maxParameters: number
) => {
  const found = new Map<string, JobId>();
  for (const batch of rowBatches(keys, 1, maxParameters, 1)) {
    const rows = await transaction
      .select({ id: queueJobs.id, key: queueJobs.idempotencyKey })
      .from(queueJobs)
      .where(
        and(
          eq(queueJobs.scope, scope),
          inArray(queueJobs.idempotencyKey, batch)
        )
      );
    for (const row of rows) {
      if (row.key !== null) {
        found.set(row.key, row.id);
      }
    }
  }
  return found;
};

const storedRevisions = async (
  transaction: QueueTransaction,
  scope: string,
  write: QueueWrite,
  maxParameters: number
): Promise<StoredRevisions> => {
  const runs = await revisionsIn(
    transaction,
    queueRuns,
    scope,
    (write.expected?.runs ?? []).map(({ id }) => id),
    maxParameters
  );
  const suspensions = await revisionsIn(
    transaction,
    queueSuspensions,
    scope,
    (write.expected?.suspensions ?? []).map(({ id }) => id),
    maxParameters
  );
  const holders = await holdersIn(
    transaction,
    scope,
    (write.jobs ?? []).flatMap((job) =>
      job.policy.idempotencyKey === undefined ? [] : [job.policy.idempotencyKey]
    ),
    maxParameters
  );
  return {
    holderOf: (key) => holders.get(key),
    runRevision: (id) => runs.get(id),
    suspensionRevision: (id) => suspensions.get(id),
  };
};

const matching = (
  ...conditions: readonly [SQLiteColumn, string | undefined][]
): SQL | undefined =>
  and(
    ...conditions.map(([column, value]) =>
      value === undefined ? undefined : eq(column, value)
    )
  );

export const makeSqliteQueueStore = (
  options: SqliteQueueStoreOptions
): QueueStoreService => {
  if (options.scope.length === 0) {
    throw new RangeError("scope must be a nonempty string");
  }
  const { database, scope } = options;
  const maxParameters = resolveMaxParameters(
    options.maxParameters ?? DEFAULT_BATCH_PARAMETERS
  );
  const turns = new Turns(REENTRY);
  const run = <A>(work: () => Promise<A>) =>
    Effect.tryPromise({
      catch: (cause) => new StoreError({ cause }),
      try: () => turns.run(work),
    });
  const bodies = <Body>(
    table: typeof queueJobs | typeof queueRuns | typeof queueSuspensions,
    where: SQL | undefined
  ) =>
    run(async () => {
      const rows = await database
        .select({ body: table.body })
        .from(table)
        .where(and(eq(table.scope, scope), where));
      return rows.map((row) => row.body as Body);
    });
  const first = <Body>(rows: Effect.Effect<readonly Body[], StoreError>) =>
    Effect.map(rows, ([found]) => found);

  const watermarkEnabled = options.watermark ?? true;

  return {
    capabilities: { watermark: watermarkEnabled },
    commit: (write) =>
      Effect.tryPromise({
        catch: (cause) =>
          cause instanceof WriteConflictError
            ? cause
            : new StoreError({ cause }),
        try: () =>
          turns.run(() =>
            database.transaction(async (transaction) => {
              const conflict = conflictOf(
                write,
                await storedRevisions(transaction, scope, write, maxParameters)
              );
              if (conflict !== undefined) {
                throw new WriteConflictError({ id: conflict });
              }
              await writeRecords(transaction, scope, write, maxParameters);
              await deleteRecords(transaction, scope, write, maxParameters);
              if (options.watermark ?? true) {
                await raiseWatermark(transaction, scope);
              }
              await options.onCommit?.(transaction, write);
            })
          ),
      }),
    getJob: (id) => first(bodies<Job>(queueJobs, eq(queueJobs.id, id))),
    getRun: (id) => first(bodies<Run>(queueRuns, eq(queueRuns.id, id))),
    getSuspension: (id) =>
      first(bodies<Suspension>(queueSuspensions, eq(queueSuspensions.id, id))),
    listJobs: (filter = {}) =>
      bodies<Job>(
        queueJobs,
        matching(
          [queueJobs.state, filter.state],
          [queueJobs.idempotencyKey, filter.idempotencyKey]
        )
      ),
    listPools: run(async () => {
      const rows = await database
        .select()
        .from(queuePools)
        .where(eq(queuePools.scope, scope));
      return rows.map(
        (row): ConcurrencyPool => ({
          limit: row.limit ?? Number.POSITIVE_INFINITY,
          name: row.name,
          state: row.state,
        })
      );
    }),
    listRuns: (filter = {}) =>
      run(async () => {
        const conditions = buildRunFilterConditions(scope, filter);
        const base = database
          .select({ body: queueRuns.body })
          .from(queueRuns)
          .where(and(...conditions));
        const orderColumn = orderColumnFor(filter.orderBy);
        const orderedQuery =
          orderColumn === undefined
            ? base
            : base.orderBy(orderColumn, asc(queueRuns.id));
        const rows =
          filter.limit === undefined
            ? await orderedQuery
            : await orderedQuery.limit(Math.max(0, filter.limit));
        return rows.map((row) => row.body);
      }),
    listSuspensions: (filter = {}) =>
      bodies<Suspension>(
        queueSuspensions,
        matching(
          [queueSuspensions.state, filter.state],
          [queueSuspensions.runId, filter.runId]
        )
      ),
    watermark: run(async () => {
      const [row] = await database
        .select({ value: queueWatermarks.value })
        .from(queueWatermarks)
        .where(eq(queueWatermarks.scope, scope));
      return row?.value ?? 0;
    }),
  };
};

const buildRunFilterConditions = (
  scope: string,
  filter: RunFilter
): (SQL | undefined)[] => {
  const conditions: (SQL | undefined)[] = [
    eq(queueRuns.scope, scope),
    filter.state === undefined ? undefined : eq(queueRuns.state, filter.state),
    filter.jobId === undefined ? undefined : eq(queueRuns.jobId, filter.jobId),
    filter.pool === undefined ? undefined : eq(queueRuns.pool, filter.pool),
    filter.availableBefore === undefined
      ? undefined
      : and(
          isNotNull(queueRuns.availableAt),
          lte(queueRuns.availableAt, filter.availableBefore)
        ),
    filter.leaseExpiredBefore === undefined
      ? undefined
      : and(
          isNotNull(queueRuns.leaseExpiresAt),
          lte(queueRuns.leaseExpiresAt, filter.leaseExpiredBefore)
        ),
  ];
  if (filter.orderBy === "availableAt") {
    conditions.push(isNotNull(queueRuns.availableAt));
  }
  if (filter.orderBy === "leaseExpiresAt") {
    conditions.push(isNotNull(queueRuns.leaseExpiresAt));
  }
  return conditions;
};

const orderColumnFor = (orderBy: RunFilter["orderBy"]) => {
  if (orderBy === "availableAt") {
    return asc(queueRuns.availableAt);
  }
  if (orderBy === "leaseExpiresAt") {
    return asc(queueRuns.leaseExpiresAt);
  }
};

export const SqliteQueueStore = (
  options: SqliteQueueStoreOptions
): Layer.Layer<QueueStore> =>
  Layer.sync(QueueStore, () => makeSqliteQueueStore(options));
