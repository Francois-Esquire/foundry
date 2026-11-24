import { canonicalizeJson } from "@foundry/lib/json";
import { Turns } from "@foundry/lib/turns";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type {
  BaseSQLiteDatabase,
  SQLiteColumn,
  SQLiteTable,
  SQLiteTransaction,
  SQLiteUpdateSetSource,
} from "drizzle-orm/sqlite-core";
import { Effect, Layer } from "effect";
import {
  type Occurrence,
  type Schedule,
  type ScheduleCursor,
  StoreError,
} from "../domain";
import {
  ScheduleStore,
  type ScheduleStoreService,
  type ScheduleWrite,
} from "./index";
import {
  schedulingCursors,
  schedulingOccurrences,
  schedulingSchedules,
} from "./tables";

export type ScheduleDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

export type ScheduleTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export interface SqliteScheduleStoreOptions {
  readonly database: ScheduleDatabase;
  readonly onCommit?: (
    transaction: ScheduleTransaction,
    write: ScheduleWrite
  ) => Promise<void>;
  readonly scope: string;
}

const REENTRY =
  "SqliteScheduleStore was called from inside its own transaction or onCommit hook; use the transaction passed to onCommit instead";

const BATCH = 500;

const batches = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );

const occurrenceRow = (scope: string, occurrence: Occurrence) => ({
  body: occurrence,
  id: occurrence.id,
  scheduledFor: occurrence.scheduledFor,
  scheduleId: occurrence.scheduleId,
  scope,
  state: occurrence.state.kind,
});

const upsert = async <Table extends SQLiteTable>(
  transaction: ScheduleTransaction,
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

const removeSchedules = async (
  transaction: ScheduleTransaction,
  scope: string,
  ids: readonly string[]
) => {
  for (const [table, column] of [
    [schedulingSchedules, schedulingSchedules.id],
    [schedulingCursors, schedulingCursors.scheduleId],
    [schedulingOccurrences, schedulingOccurrences.scheduleId],
  ] as const) {
    for (const batch of batches(ids, BATCH)) {
      await transaction
        .delete(table)
        .where(and(eq(table.scope, scope), inArray(column, batch)));
    }
  }
};

const writeRecords = async (
  transaction: ScheduleTransaction,
  scope: string,
  write: ScheduleWrite
) => {
  await removeSchedules(transaction, scope, write.removed ?? []);
  await upsert(
    transaction,
    schedulingSchedules,
    [schedulingSchedules.scope, schedulingSchedules.id],
    (write.schedules ?? []).map((schedule) => ({
      body: schedule,
      id: schedule.id,
      scope,
    })),
    ["body"]
  );
  await upsert(
    transaction,
    schedulingCursors,
    [schedulingCursors.scope, schedulingCursors.scheduleId],
    (write.cursors ?? []).map((cursor) => ({
      body: cursor,
      nextDueAt: cursor.nextDueAt,
      scheduleId: cursor.scheduleId,
      scope,
    })),
    ["body", "nextDueAt"]
  );
  await upsert(
    transaction,
    schedulingOccurrences,
    [schedulingOccurrences.scope, schedulingOccurrences.id],
    (write.occurrences ?? []).map((o) => occurrenceRow(scope, o)),
    ["body", "state"]
  );
};

export const makeSqliteScheduleStore = (
  options: SqliteScheduleStoreOptions
): ScheduleStoreService => {
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
    table:
      | typeof schedulingCursors
      | typeof schedulingOccurrences
      | typeof schedulingSchedules,
    where: SQL | undefined,
    order?: SQLiteColumn
  ) =>
    run(async () => {
      const query = database
        .select({ body: table.body })
        .from(table)
        .where(and(eq(table.scope, scope), where));
      const rows = await (order === undefined ? query : query.orderBy(order));
      return rows.map((row) => row.body as Body);
    });
  const first = <Body>(rows: Effect.Effect<readonly Body[], StoreError>) =>
    Effect.map(rows, ([found]) => found);

  return {
    claim: (occurrence, replacing) =>
      run(async () => {
        if (replacing === undefined) {
          const inserted = await database
            .insert(schedulingOccurrences)
            .values(occurrenceRow(scope, occurrence))
            .onConflictDoNothing()
            .returning({ id: schedulingOccurrences.id });
          return inserted.length > 0;
        }
        return await database.transaction(async (transaction) => {
          const where = and(
            eq(schedulingOccurrences.scope, scope),
            eq(schedulingOccurrences.id, occurrence.id)
          );
          const [stored] = await transaction
            .select({ body: schedulingOccurrences.body })
            .from(schedulingOccurrences)
            .where(where);
          if (
            stored === undefined ||
            canonicalizeJson(stored.body) !== canonicalizeJson(replacing)
          ) {
            return false;
          }
          await transaction
            .update(schedulingOccurrences)
            .set({ body: occurrence, state: occurrence.state.kind })
            .where(where);
          return true;
        });
      }),
    commit: (write) =>
      run(() =>
        database.transaction(async (transaction) => {
          await writeRecords(transaction, scope, write);
          await options.onCommit?.(transaction, write);
        })
      ),
    getCursor: (id) =>
      first(
        bodies<ScheduleCursor>(
          schedulingCursors,
          eq(schedulingCursors.scheduleId, id)
        )
      ),
    getOccurrence: (id) =>
      first(
        bodies<Occurrence>(
          schedulingOccurrences,
          eq(schedulingOccurrences.id, id)
        )
      ),
    getSchedule: (id) =>
      first(
        bodies<Schedule>(schedulingSchedules, eq(schedulingSchedules.id, id))
      ),
    listOccurrences: (filter = {}) =>
      bodies<Occurrence>(
        schedulingOccurrences,
        and(
          filter.scheduleId === undefined
            ? undefined
            : eq(schedulingOccurrences.scheduleId, filter.scheduleId),
          filter.state === undefined
            ? undefined
            : eq(schedulingOccurrences.state, filter.state)
        ),
        schedulingOccurrences.scheduledFor
      ),
    listSchedules: bodies<Schedule>(schedulingSchedules, undefined),
  };
};

export const SqliteScheduleStore = (
  options: SqliteScheduleStoreOptions
): Layer.Layer<ScheduleStore> =>
  Layer.sync(ScheduleStore, () => makeSqliteScheduleStore(options));
