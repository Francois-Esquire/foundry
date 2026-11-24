import { Turns } from "@foundry/lib/turns";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { and, eq, getTableColumns, type SQL, sql } from "drizzle-orm";
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
  type Wait,
} from "../domain";
import { QueueStore, type QueueStoreService, type QueueWrite } from "./index";
import { queueJobs, queuePools, queueRuns, queueWaits } from "./tables";

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

const upsert = async <Table extends SQLiteTable>(
  transaction: QueueTransaction,
  table: Table,
  target: readonly SQLiteColumn[],
  rows: readonly Table["$inferInsert"][],
  update: readonly (keyof Table["$inferInsert"] & string)[]
) => {
  if (rows.length === 0) {
    return;
  }
  const columns: Record<string, SQLiteColumn> = getTableColumns(table);
  await transaction
    .insert(table)
    .values([...rows])
    .onConflictDoUpdate({
      set: Object.fromEntries(
        update.map((key) => [
          key,
          sql.raw(`excluded."${columns[key]?.name ?? key}"`),
        ])
      ) as SQLiteUpdateSetSource<Table>,
      target: [...target],
    });
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
    queueWaits,
    [queueWaits.scope, queueWaits.id],
    (write.waits ?? []).map((wait) => ({
      body: wait,
      id: wait.id,
      runId: wait.runId,
      scope,
      state: wait.state.kind,
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
    table: typeof queueJobs | typeof queueRuns | typeof queueWaits,
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
          await options.onCommit?.(transaction, write);
        })
      ),
    getJob: (id) => first(bodies<Job>(queueJobs, eq(queueJobs.id, id))),
    getRun: (id) => first(bodies<Run>(queueRuns, eq(queueRuns.id, id))),
    getWait: (id) => first(bodies<Wait>(queueWaits, eq(queueWaits.id, id))),
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
    listWaits: (filter = {}) =>
      bodies<Wait>(
        queueWaits,
        matching(
          [queueWaits.state, filter.state],
          [queueWaits.runId, filter.runId]
        )
      ),
  };
};

export const SqliteQueueStore = (
  options: SqliteQueueStoreOptions
): Layer.Layer<QueueStore> =>
  Layer.sync(QueueStore, () => makeSqliteQueueStore(options));
