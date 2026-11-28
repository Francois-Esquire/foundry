import { sameInstance } from "@foundry/lib/instance-identity";
import { canonicalizeJson } from "@foundry/lib/json";
import {
  resolveMaxParameters,
  rowBatches,
  type SqliteDatabase,
  type SqliteTransaction,
} from "@foundry/lib/sqlite";
import { Turns } from "@foundry/lib/turns";
import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  lte,
  min,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type {
  SQLiteColumn,
  SQLiteTable,
  SQLiteUpdateSetSource,
} from "drizzle-orm/sqlite-core";
import { Effect, Layer } from "effect";
import {
  CursorConflictError,
  type Occurrence,
  type Schedule,
  ScheduleConflictError,
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

export type ScheduleDatabase = SqliteDatabase;

export type ScheduleTransaction = SqliteTransaction;

export interface SqliteScheduleStoreOptions {
  readonly database: ScheduleDatabase;
  readonly maxParameters?: number;
  readonly onCommit?: (
    transaction: ScheduleTransaction,
    write: ScheduleWrite
  ) => Promise<void>;
  readonly scope: string;
}

const REENTRY =
  "SqliteScheduleStore was called from inside its own transaction or onCommit hook; use the transaction passed to onCommit instead";

const DEFAULT_BATCH_PARAMETERS = 500;

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

const removeSchedules = async (
  transaction: ScheduleTransaction,
  scope: string,
  ids: readonly string[],
  maxParameters: number
) => {
  for (const [table, column] of [
    [schedulingSchedules, schedulingSchedules.id],
    [schedulingCursors, schedulingCursors.scheduleId],
    [schedulingOccurrences, schedulingOccurrences.scheduleId],
  ] as const) {
    for (const batch of rowBatches(ids, 1, maxParameters, 1)) {
      await transaction
        .delete(table)
        .where(and(eq(table.scope, scope), inArray(column, batch)));
    }
  }
};

const TERMINAL = ["settled", "skipped"] as const;

const pruneOccurrences = async (
  transaction: ScheduleTransaction,
  scope: string,
  write: ScheduleWrite
) => {
  const keep = write.maxOccurrencesPerSchedule;
  if (keep === undefined) {
    return;
  }
  const touched = new Set((write.occurrences ?? []).map((o) => o.scheduleId));
  for (const scheduleId of touched) {
    const terminal = and(
      eq(schedulingOccurrences.scope, scope),
      eq(schedulingOccurrences.scheduleId, scheduleId),
      inArray(schedulingOccurrences.state, [...TERMINAL])
    );
    const newest = transaction
      .select({ id: schedulingOccurrences.id })
      .from(schedulingOccurrences)
      .where(terminal)
      .orderBy(desc(schedulingOccurrences.scheduledFor))
      .limit(keep);
    await transaction
      .delete(schedulingOccurrences)
      .where(and(terminal, notInArray(schedulingOccurrences.id, newest)));
  }
};

const requireExpectedSchedules = async (
  transaction: ScheduleTransaction,
  scope: string,
  write: ScheduleWrite
) => {
  for (const expected of write.expectedSchedules ?? []) {
    const [stored] = await transaction
      .select({ body: schedulingSchedules.body })
      .from(schedulingSchedules)
      .where(
        and(
          eq(schedulingSchedules.scope, scope),
          eq(schedulingSchedules.id, expected.id)
        )
      );
    if (canonicalizeJson(stored?.body ?? null) !== canonicalizeJson(expected)) {
      throw new ScheduleConflictError({ scheduleId: expected.id });
    }
  }
};

const requireExpectedCursors = async (
  transaction: ScheduleTransaction,
  scope: string,
  write: ScheduleWrite
) => {
  for (const expected of write.expectedCursors ?? []) {
    const [stored] = await transaction
      .select({ body: schedulingCursors.body })
      .from(schedulingCursors)
      .where(
        and(
          eq(schedulingCursors.scope, scope),
          eq(schedulingCursors.scheduleId, expected.scheduleId)
        )
      );
    if (canonicalizeJson(stored?.body ?? null) !== canonicalizeJson(expected)) {
      throw new CursorConflictError({ scheduleId: expected.scheduleId });
    }
  }
};

const writeRecords = async (
  transaction: ScheduleTransaction,
  scope: string,
  write: ScheduleWrite,
  maxParameters: number
) => {
  await requireExpectedSchedules(transaction, scope, write);
  await requireExpectedCursors(transaction, scope, write);
  await removeSchedules(transaction, scope, write.removed ?? [], maxParameters);
  await upsert(
    transaction,
    schedulingSchedules,
    [schedulingSchedules.scope, schedulingSchedules.id],
    (write.schedules ?? []).map((schedule) => ({
      body: schedule,
      id: schedule.id,
      scope,
    })),
    ["body"],
    maxParameters
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
    ["body", "nextDueAt"],
    maxParameters
  );
  await upsert(
    transaction,
    schedulingOccurrences,
    [schedulingOccurrences.scope, schedulingOccurrences.id],
    (write.occurrences ?? []).map((o) => occurrenceRow(scope, o)),
    ["body", "state"],
    maxParameters
  );
  await pruneOccurrences(transaction, scope, write);
};

export const makeSqliteScheduleStore = (
  options: SqliteScheduleStoreOptions
): ScheduleStoreService => {
  if (options.scope.length === 0) {
    throw new RangeError("scope must be a nonempty string");
  }
  const { database, scope } = options;
  const maxParameters = resolveMaxParameters(
    options.maxParameters ?? DEFAULT_BATCH_PARAMETERS
  );
  const turns = new Turns(REENTRY);
  const run = <A>(work: () => A | PromiseLike<A>) =>
    Effect.tryPromise({
      catch: (cause) => new StoreError({ cause }),
      try: () => turns.run(work),
    });
  const guarded = (work: () => void | PromiseLike<void>) =>
    Effect.tryPromise({
      catch: (cause) =>
        cause instanceof CursorConflictError ||
        cause instanceof ScheduleConflictError
          ? cause
          : new StoreError({ cause }),
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
    claim: (occurrence, replacing, exclusive = false) =>
      run(async () => {
        if (replacing === undefined && !exclusive) {
          const inserted = await database
            .insert(schedulingOccurrences)
            .values(occurrenceRow(scope, occurrence))
            .onConflictDoNothing()
            .returning({ id: schedulingOccurrences.id });
          return inserted.length > 0;
        }
        return await database.transaction(async (transaction) => {
          if (exclusive) {
            const [other] = await transaction
              .select({ id: schedulingOccurrences.id })
              .from(schedulingOccurrences)
              .where(
                and(
                  eq(schedulingOccurrences.scope, scope),
                  eq(schedulingOccurrences.scheduleId, occurrence.scheduleId),
                  eq(schedulingOccurrences.state, "claimed"),
                  ne(schedulingOccurrences.id, occurrence.id)
                )
              )
              .limit(1);
            if (other !== undefined) {
              return false;
            }
          }
          if (replacing === undefined) {
            const inserted = await transaction
              .insert(schedulingOccurrences)
              .values(occurrenceRow(scope, occurrence))
              .onConflictDoNothing()
              .returning({ id: schedulingOccurrences.id });
            return inserted.length > 0;
          }
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
      guarded(() =>
        database.transaction(async (transaction) => {
          await writeRecords(transaction, scope, write, maxParameters);
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
    latestOccurrence: (scheduleId) =>
      run(async () => {
        const [row] = await database
          .select({ body: schedulingOccurrences.body })
          .from(schedulingOccurrences)
          .where(
            and(
              eq(schedulingOccurrences.scope, scope),
              eq(schedulingOccurrences.scheduleId, scheduleId)
            )
          )
          .orderBy(desc(schedulingOccurrences.scheduledFor))
          .limit(1);
        return row?.body;
      }),
    listDueSchedules: (now, listOptions = {}) =>
      run(async () => {
        const base = database
          .select({
            body: schedulingSchedules.body,
          })
          .from(schedulingCursors)
          .innerJoin(
            schedulingSchedules,
            and(
              eq(schedulingSchedules.scope, schedulingCursors.scope),
              eq(schedulingSchedules.id, schedulingCursors.scheduleId)
            )
          )
          .where(
            and(
              eq(schedulingCursors.scope, scope),
              or(
                and(
                  sql`json_extract(${schedulingSchedules.body}, '$.state') = 'active'`,
                  isNotNull(schedulingCursors.nextDueAt),
                  lte(schedulingCursors.nextDueAt, now)
                ),
                sql`json_extract(${schedulingCursors.body}, '$.activeJobId') IS NOT NULL`,
                sql`EXISTS (SELECT 1 FROM ${schedulingOccurrences} WHERE ${schedulingOccurrences.scope} = ${schedulingCursors.scope} AND ${schedulingOccurrences.scheduleId} = ${schedulingCursors.scheduleId} AND ${schedulingOccurrences.state} = 'dispatched')`
              )
            )
          )
          .orderBy(
            sql`CASE WHEN ${schedulingCursors.nextDueAt} IS NULL THEN 1 ELSE 0 END ASC`,
            asc(schedulingCursors.nextDueAt)
          );
        const rows = await (listOptions.limit === undefined
          ? base
          : base.limit(Math.max(0, listOptions.limit)));
        return rows.map((row) => row.body);
      }),
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
    nextDueAt: run(async () => {
      const [row] = await database
        .select({ soonest: min(schedulingCursors.nextDueAt) })
        .from(schedulingCursors)
        .innerJoin(
          schedulingSchedules,
          and(
            eq(schedulingSchedules.scope, schedulingCursors.scope),
            eq(schedulingSchedules.id, schedulingCursors.scheduleId)
          )
        )
        .where(
          and(
            eq(schedulingCursors.scope, scope),
            isNotNull(schedulingCursors.nextDueAt),
            sql`json_extract(${schedulingSchedules.body}, '$.state') = 'active'`
          )
        );
      return row?.soonest ?? undefined;
    }),
    releaseClaim: (id, owner) =>
      run(() =>
        database.transaction(async (transaction) => {
          const where = and(
            eq(schedulingOccurrences.scope, scope),
            eq(schedulingOccurrences.id, id)
          );
          const [stored] = await transaction
            .select({ body: schedulingOccurrences.body })
            .from(schedulingOccurrences)
            .where(where);
          const state = stored?.body.state;
          if (
            state?.kind === "claimed" &&
            sameInstance(state.lease.owner, owner)
          ) {
            await transaction.delete(schedulingOccurrences).where(where);
          }
        })
      ),
  };
};

export const SqliteScheduleStore = (
  options: SqliteScheduleStoreOptions
): Layer.Layer<ScheduleStore> =>
  Layer.sync(ScheduleStore, () => makeSqliteScheduleStore(options));
