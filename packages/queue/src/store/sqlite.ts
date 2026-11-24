import { Turns } from "@foundry/lib/turns";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { and, eq, getTableColumns, inArray, type SQL, sql } from "drizzle-orm";
import type {
  BaseSQLiteDatabase,
  SQLiteColumn,
  SQLiteTable,
  SQLiteTransaction,
  SQLiteUpdateSetSource,
} from "drizzle-orm/sqlite-core";
import { Effect, Layer } from "effect";
import {
  type ConcurrencyPool,
  type Job,
  type Run,
  StoreError,
  type Suspension,
} from "../domain";
import { QueueStore, type QueueStoreService, type QueueWrite } from "./index";
import { queueJobs, queuePools, queueRuns, queueSuspensions } from "./tables";

export type QueueDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

export type QueueTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export interface SqliteQueueStoreOptions {
  readonly database: QueueDatabase;
  readonly onCommit?: (
    transaction: QueueTransaction,
    write: QueueWrite
  ) => Promise<void>;
  readonly scope: string;
}

const REENTRY =
  "SqliteQueueStore was called from inside its own transaction or onCommit hook; use the transaction passed to onCommit instead";

const BATCH = 500;

const batches = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );

const upsert = async <Table extends SQLiteTable>(
  transaction: QueueTransaction,
  table: Table,
  target: readonly SQLiteColumn[],
  rows: readonly Table["$inferInsert"][],
  update: readonly (keyof Table["$inferInsert"] & string)[]
) => {
  const columns: Record<string, SQLiteColumn> = getTableColumns(table);
  const set = Object.fromEntries(
    update.map((key) => [
      key,
      sql.raw(`excluded."${columns[key]?.name ?? key}"`),
    ])
  ) as SQLiteUpdateSetSource<Table>;
  const size = Math.max(1, Math.floor(BATCH / Object.keys(columns).length));
  for (const batch of batches(rows, size)) {
    await transaction
      .insert(table)
      .values(batch)
      .onConflictDoUpdate({ set, target: [...target] });
  }
};

const writeRecords = async (
  transaction: QueueTransaction,
  scope: string,
  write: QueueWrite
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
    ["body", "idempotencyKey", "state"]
  );
  await upsert(
    transaction,
    queueRuns,
    [queueRuns.scope, queueRuns.id],
    (write.runs ?? []).map((run) => ({
      body: run,
      id: run.id,
      jobId: run.jobId,
      scope,
      state: run.state.kind,
    })),
    ["body", "state"]
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
    ["body", "state"]
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
    ["limit", "state"]
  );
};

const remove = async (
  transaction: QueueTransaction,
  table: typeof queueJobs | typeof queueRuns | typeof queueSuspensions,
  column: SQLiteColumn,
  scope: string,
  ids: readonly string[] | undefined
) => {
  for (const batch of batches(ids ?? [], BATCH)) {
    await transaction
      .delete(table)
      .where(and(eq(table.scope, scope), inArray(column, batch)));
  }
};

const deleteRecords = async (
  transaction: QueueTransaction,
  scope: string,
  write: QueueWrite
) => {
  await remove(
    transaction,
    queueSuspensions,
    queueSuspensions.id,
    scope,
    write.deleteSuspensions
  );
  await remove(transaction, queueRuns, queueRuns.id, scope, write.deleteRuns);
  await remove(transaction, queueJobs, queueJobs.id, scope, write.deleteJobs);
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

  return {
    commit: (write) =>
      run(() =>
        database.transaction(async (transaction) => {
          await writeRecords(transaction, scope, write);
          await deleteRecords(transaction, scope, write);
          await options.onCommit?.(transaction, write);
        })
      ),
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
      bodies<Run>(
        queueRuns,
        matching(
          [queueRuns.state, filter.state],
          [queueRuns.jobId, filter.jobId]
        )
      ),
    listSuspensions: (filter = {}) =>
      bodies<Suspension>(
        queueSuspensions,
        matching(
          [queueSuspensions.state, filter.state],
          [queueSuspensions.runId, filter.runId]
        )
      ),
  };
};

export const SqliteQueueStore = (
  options: SqliteQueueStoreOptions
): Layer.Layer<QueueStore> =>
  Layer.sync(QueueStore, () => makeSqliteQueueStore(options));
