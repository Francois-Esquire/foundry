import { Turns } from "@foundry/lib/turns";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  is,
  max,
  sql,
} from "drizzle-orm";
import type {
  BaseSQLiteDatabase,
  SQLiteColumn,
  SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { SQLiteTransaction } from "drizzle-orm/sqlite-core";

import { detached } from "../detached";
import { defineOwnEntry } from "../own-entry";
import type {
  JobRecord,
  QueueRecord,
  RunFrame,
  RunRecord,
  SuspensionRecord,
} from "../schema";
import { capturedWrite } from "./captured";
import type {
  FrameListQuery,
  JobListQuery,
  RunListQuery,
  SuspensionListQuery,
  WorkflowStore,
  WorkflowStoreDurability,
  WorkflowStorePage,
  WorkflowStorePageQuery,
  WorkflowStoreWrite,
} from "./index";
import { ownedQuery } from "./page";
import type { RecordKind } from "./sqlite-records";
import {
  below,
  describe,
  FRAME,
  JOB,
  kept,
  QUEUE,
  RecordFault,
  RUN,
  SUSPENSION,
  storable,
} from "./sqlite-records";
import {
  workflowJobs,
  workflowPositions,
  workflowQueues,
  workflowRunFrames,
  workflowRuns,
  workflowSuspensions,
} from "./tables";

/**
 * An async Drizzle SQLite database, with or without a relational schema, or a
 * transaction on one. A `drizzle-orm/libsql` database and its transactions
 * both satisfy it, so a host can hand the store either.
 */
export type WorkflowDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

/** The transaction one `commit` runs in, as `onCommit` receives it. */
export type WorkflowTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export interface SqliteWorkflowStoreOptions {
  /** Opened, migrated, and owned by the host; the store never closes it. */
  readonly database: WorkflowDatabase;
  /**
   * When a commit that resolved is there for good (see
   * `WorkflowStoreDurability`). A Drizzle transaction handed in as
   * `database` is one the host owns and may roll back, so the store is
   * `"host"` over it whatever this says, and refuses `"commit"`. Over a
   * plain database the default is `"commit"`; pass `"host"` when the host
   * has begun a transaction of its own on the connection (a raw `BEGIN`),
   * which the store cannot see.
   */
  readonly durability?: WorkflowStoreDurability;
  /**
   * Runs inside the commit's transaction after the store's own statements,
   * so the host can record the change atomically with it. A throw rolls the
   * whole commit back. It receives the store's own copy of the write, taken
   * when `commit` was called: exactly what the store wrote, every record
   * put, whole, in the write's order, and every id a delete named. It does
   * not say which put filed a record and which replaced one, or what a
   * replaced or deleted record held; the store has already written when
   * the hook runs, so that is gone.
   */
  readonly onCommit?: (
    transaction: WorkflowTransaction,
    write: WorkflowStoreWrite
  ) => Promise<void>;
  /** The partition this store reads and writes; any nonempty string. */
  readonly scope: string;
}

/** Why a call from inside the store's own transaction or hook is refused. */
const REENTRY =
  "SqliteWorkflowStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

/** A record kind's table, the columns that key a row, and how a row is told. */
interface Shelf<T> {
  readonly keys: readonly SQLiteColumn[];
  readonly kind: RecordKind<T>;
  /** What a row is called in a refusal to read it, such as `Run "rn-1"`. */
  readonly name: (record: Readonly<Record<string, unknown>>) => string;
  readonly table: StoreTable;
}

type StoreTable =
  | typeof workflowJobs
  | typeof workflowQueues
  | typeof workflowRunFrames
  | typeof workflowRuns
  | typeof workflowSuspensions;

const QUEUES: Shelf<QueueRecord> = {
  keys: [workflowQueues.scope, workflowQueues.id],
  kind: QUEUE,
  name: (row) => `Queue ${JSON.stringify(row.id)}`,
  table: workflowQueues,
};
const JOBS: Shelf<JobRecord> = {
  keys: [workflowJobs.scope, workflowJobs.id],
  kind: JOB,
  name: (row) => `Job ${JSON.stringify(row.id)}`,
  table: workflowJobs,
};
const RUNS: Shelf<RunRecord> = {
  keys: [workflowRuns.scope, workflowRuns.id],
  kind: RUN,
  name: (row) => `Run ${JSON.stringify(row.id)}`,
  table: workflowRuns,
};
const SUSPENSIONS: Shelf<SuspensionRecord> = {
  keys: [workflowSuspensions.scope, workflowSuspensions.id],
  kind: SUSPENSION,
  name: (row) => `Suspension ${JSON.stringify(row.id)}`,
  table: workflowSuspensions,
};
const FRAMES: Shelf<RunFrame> = {
  keys: [
    workflowRunFrames.scope,
    workflowRunFrames.runId,
    workflowRunFrames.cursor,
  ],
  kind: FRAME,
  name: (row) =>
    `frame ${String(row.cursor)} of Run ${JSON.stringify(row.runId)}`,
  table: workflowRunFrames,
};

/**
 * A `WorkflowStore` over the host's SQLite database, in the tables from
 * `@foundry/workflows/store/tables`. It behaves as `MemoryWorkflowStore`
 * does, within its scope.
 *
 * Its calls take turns, as the memory store's do: a call made while a
 * transaction or commit runs waits for it. That keeps two coordinators over
 * one store apart in this process, and keeps a `:memory:` database, which
 * has a single connection, from refusing a call while a transaction holds
 * it. Across connections and processes, `transaction` takes the database's
 * write lock (see there).
 */
export class SqliteWorkflowStore implements WorkflowStore {
  readonly durability: WorkflowStoreDurability;
  readonly #database: WorkflowDatabase;
  readonly #scope: string;
  readonly #onCommit: SqliteWorkflowStoreOptions["onCommit"];
  readonly #turns = new Turns(REENTRY);

  constructor(options: SqliteWorkflowStoreOptions) {
    if (options.scope.length === 0 || !storable(options.scope)) {
      throw new RangeError(
        "scope must be a nonempty string with no U+0000 and no lone surrogate"
      );
    }
    const joined = is(options.database, SQLiteTransaction);
    if (joined && options.durability === "commit") {
      throw new RangeError(
        'database is a transaction the host owns, which it may roll back: a commit is durable only when the host\'s is, so durability cannot be "commit"'
      );
    }
    this.durability = joined ? "host" : (options.durability ?? "commit");
    this.#database = options.database;
    this.#scope = options.scope;
    this.#onCommit = options.onCommit;
  }

  /**
   * One database transaction: the deletes, then the puts, then `onCommit`.
   * The store takes its own copy of `write` when it is called, before it
   * waits for its turn, and writes that copy and hands it to `onCommit`, so
   * a caller changing `write` afterwards changes neither. Rejects, before
   * writing anything, a write holding a value SQLite or JSON would not give
   * back intact, naming its field (see `./sqlite-records`). A delete of a
   * key no row can hold does nothing.
   */
  commit(write: WorkflowStoreWrite): Promise<void> {
    let taken: OwnedWrite;
    try {
      taken = owned(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() =>
      this.#database.transaction(async (transaction) => {
        // Before the deletes: a scope's first counter starts past every
        // position it holds now, rows about to go included.
        const positions = await this.#positions(transaction, taken);
        await this.#delete(
          transaction,
          workflowJobs.id,
          taken.write.deleteJobs
        );
        await this.#delete(
          transaction,
          workflowRuns.id,
          taken.write.deleteRuns
        );
        await this.#delete(
          transaction,
          workflowSuspensions.id,
          taken.write.deleteSuspensions
        );
        await this.#delete(
          transaction,
          workflowRunFrames.runId,
          taken.write.deleteRunFrames
        );
        await this.#put(transaction, QUEUES, taken.queues, positions);
        await this.#put(transaction, JOBS, taken.jobs, positions);
        await this.#put(transaction, RUNS, taken.runs, positions);
        await this.#put(transaction, SUSPENSIONS, taken.suspensions, positions);
        await this.#put(transaction, FRAMES, taken.frames, positions);
        await this.#savePositions(transaction, positions);
        await this.#onCommit?.(transaction, taken.write);
      })
    );
  }

  /**
   * Runs `work` inside one database transaction, over a view whose reads
   * and commits use it; a throw from `work` rolls everything back. In this
   * process, the store's other calls wait for it. Across connections, the
   * transaction holds SQLite's write lock from its first statement: Drizzle's
   * libSQL driver opens every transaction with libSQL's default mode,
   * `BEGIN IMMEDIATE`. Another connection's write then waits for it, for as
   * long as that connection's busy timeout allows, or fails with
   * `SQLITE_BUSY`; it never lands between `work`'s reads and its commit.
   */
  transaction<T>(work: (view: WorkflowStore) => Promise<T>): Promise<T> {
    return this.#turns.run(() =>
      this.#database.transaction((transaction) =>
        work(
          new SqliteWorkflowStore({
            database: transaction,
            scope: this.#scope,
            ...(this.#onCommit === undefined
              ? {}
              : { onCommit: this.#onCommit }),
          })
        )
      )
    );
  }

  /** `null` for an id no row can hold (see {@link storable}). */
  getJob(id: string): Promise<JobRecord | null> {
    return this.#get(JOBS, [id]);
  }

  /** `null` for an id no row can hold (see {@link storable}). */
  getQueue(id: string): Promise<QueueRecord | null> {
    return this.#get(QUEUES, [id]);
  }

  /** `null` for an id no row can hold (see {@link storable}). */
  getRun(id: string): Promise<RunRecord | null> {
    return this.#get(RUNS, [id]);
  }

  /** `null` for an id no row can hold (see {@link storable}). */
  getSuspension(id: string): Promise<SuspensionRecord | null> {
    return this.#get(SUSPENSIONS, [id]);
  }

  listFrames(query: FrameListQuery): Promise<WorkflowStorePage<RunFrame>> {
    return this.#list(FRAMES, query, (taken) => [
      exact(workflowRunFrames.runId, taken.runId),
    ]);
  }

  listJobs(query: JobListQuery): Promise<WorkflowStorePage<JobRecord>> {
    return this.#list(JOBS, query, (taken) => [
      among(workflowJobs.status, taken.status),
    ]);
  }

  /** Every Queue in the scope, in the order first put. */
  listQueues(): Promise<readonly QueueRecord[]> {
    return this.#turns.run(async () => {
      const rows = await this.#database
        .select(rawColumns(QUEUES))
        .from(workflowQueues)
        .where(eq(workflowQueues.scope, this.#scope))
        .orderBy(asc(workflowQueues.position));
      return rows.map((row) => this.#decode(QUEUES, row));
    });
  }

  listRuns(query: RunListQuery): Promise<WorkflowStorePage<RunRecord>> {
    return this.#list(RUNS, query, (taken) => [
      exact(workflowRuns.queueId, taken.queueId),
      among(workflowRuns.status, taken.status),
    ]);
  }

  listSuspensions(
    query: SuspensionListQuery
  ): Promise<WorkflowStorePage<SuspensionRecord>> {
    return this.#list(SUSPENSIONS, query, (taken) => [
      exact(workflowSuspensions.runId, taken.runId),
      among(workflowSuspensions.status, taken.status),
    ]);
  }

  #get<T>(shelf: Shelf<T>, key: readonly string[]): Promise<T | null> {
    return this.#turns.run(async () => {
      if (!key.every(storable)) {
        return null;
      }
      const [, ...columns] = shelf.keys;
      const [row] = await this.#database
        .select(rawColumns(shelf))
        .from(shelf.table)
        .where(
          and(
            eq(scopeOf(shelf.table), this.#scope),
            ...columns.map((column, index) => eq(column, key[index]))
          )
        );
      return row === undefined ? null : this.#decode(shelf, row);
    });
  }

  /**
   * One page of `shelf`'s rows in the scope, in position order, matching
   * every filter `where` makes of the store's copy of the query. A filter
   * that no row can match (see {@link Filter}) makes the page empty.
   */
  #list<Q extends WorkflowStorePageQuery, T>(
    shelf: Shelf<T>,
    query: Q,
    where: (taken: Q) => readonly Filter[]
  ): Promise<WorkflowStorePage<T>> {
    let taken: Q;
    try {
      taken = ownedQuery(query);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(async () => {
      const filters = where(taken);
      if (filters.includes(NOTHING)) {
        return { items: [] };
      }
      const position = positionOf(shelf.table);
      const rows = await this.#database
        .select({ ...rawColumns(shelf), position })
        .from(shelf.table)
        .where(
          and(
            eq(scopeOf(shelf.table), this.#scope),
            ...filters.filter((filter): filter is SQL => filter !== NOTHING),
            taken.after === undefined ? undefined : gt(position, taken.after)
          )
        )
        .orderBy(asc(position))
        .limit(taken.limit + 1);
      const page = rows.slice(0, taken.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => this.#decode(shelf, row)),
        ...(rows.length > page.length && last !== undefined
          ? { next: last.position }
          : {}),
      };
    });
  }

  async #delete(
    transaction: WorkflowTransaction,
    column: SQLiteColumn,
    ids: readonly string[]
  ): Promise<void> {
    const table = column.table as StoreTable;
    // `scope` takes one of the statement's parameters.
    await inOrder(batches(ids.filter(storable), MAX_PARAMETERS - 1), (batch) =>
      transaction
        .delete(table)
        .where(and(eq(scopeOf(table), this.#scope), inArray(column, batch)))
    );
  }

  /**
   * A new row takes the next position; one put again keeps its own, and a
   * later put of one key in a write replaces an earlier one.
   */
  async #put<T>(
    transaction: WorkflowTransaction,
    shelf: Shelf<T>,
    rows: readonly Row[],
    positions: Positions
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const placed = rows.map((row) => ({
      ...row,
      position: nextPosition(positions),
      scope: this.#scope,
    }));
    const columns = Object.keys(getTableColumns(shelf.table)).length;
    await inOrder(batches(placed, MAX_PARAMETERS / columns), (batch) =>
      transaction
        .insert(shelf.table)
        .values(batch as never[])
        .onConflictDoUpdate({
          set: replacing(shelf),
          target: [...shelf.keys],
        })
    );
  }

  /**
   * The scope's next position, from `workflow_positions`, read once for a
   * write that puts or deletes anything, before its deletes. A scope with no
   * counter row yet starts past every position any of its tables holds at
   * that moment, and the commit records the counter, so a delete-only
   * commit keeps the high-water mark of the rows it removes.
   */
  async #positions(
    transaction: WorkflowTransaction,
    taken: OwnedWrite
  ): Promise<Positions> {
    const { write } = taken;
    const changes =
      taken.queues.length +
      taken.jobs.length +
      taken.runs.length +
      taken.suspensions.length +
      taken.frames.length +
      write.deleteJobs.length +
      write.deleteRunFrames.length +
      write.deleteRuns.length +
      write.deleteSuspensions.length;
    if (changes === 0) {
      return { next: 0, start: 0 };
    }
    const [counter] = await transaction
      .select({ next: workflowPositions.next })
      .from(workflowPositions)
      .where(eq(workflowPositions.scope, this.#scope));
    if (counter !== undefined) {
      return { next: counter.next, start: counter.next };
    }
    let highest = 0;
    for (const table of TABLES) {
      const [last] = await transaction
        .select({ position: max(positionOf(table)) })
        .from(table)
        .where(eq(scopeOf(table), this.#scope));
      highest = Math.max(highest, Number(last?.position ?? 0));
    }
    return { next: highest + 1, start: Number.NaN };
  }

  /** Records the scope's counter when it is new or the write moved it. */
  async #savePositions(
    transaction: WorkflowTransaction,
    positions: Positions
  ): Promise<void> {
    if (positions.next === positions.start) {
      return;
    }
    await transaction
      .insert(workflowPositions)
      .values({ next: positions.next, scope: this.#scope })
      .onConflictDoUpdate({
        set: { next: positions.next },
        target: [workflowPositions.scope],
      });
  }

  /**
   * The record a row holds: each column as SQLite returned it, JSON columns
   * parsed, NULL in an optional column the field left out and the
   * `undeclared` fields after the declared ones, then the checks every
   * write passes. Rejects a row the store would not have written, naming
   * the scope, the record and the column or field at fault.
   */
  #decode<T>(shelf: Shelf<T>, row: Readonly<Record<string, unknown>>): T {
    const what = `${shelf.name(row)} in scope ${JSON.stringify(this.#scope)}`;
    const record: Record<string, unknown> = {};
    for (const [field, fieldKind] of Object.entries(shelf.kind.fields)) {
      const value = row[field];
      if (fieldKind === "text" || fieldKind === "integer") {
        defineOwnEntry(record, field, value);
      } else if (!(fieldKind === "optional" && value === null)) {
        defineOwnEntry(record, field, parsed(value, field, what));
      }
    }
    if (shelf.kind.undeclared && row.undeclared !== null) {
      const rest = parsed(row.undeclared, "undeclared", what);
      if (typeof rest !== "object" || rest === null || Array.isArray(rest)) {
        throw unreadable(
          what,
          `column undeclared holds ${describe(rest)}, not an object`
        );
      }
      for (const [key, value] of Object.entries(rest)) {
        defineOwnEntry(record, key, value);
      }
    }
    try {
      return kept(shelf.kind, record).record;
    } catch (error) {
      if (error instanceof RecordFault) {
        throw unreadable(
          what,
          `field ${error.path || "(record)"} ${error.reason}`,
          error
        );
      }
      throw error;
    }
  }
}

/** Every table a record is kept in. */
const TABLES: readonly StoreTable[] = [
  workflowQueues,
  workflowJobs,
  workflowRuns,
  workflowSuspensions,
  workflowRunFrames,
];

/**
 * The positions one commit hands out: `next` is the next to give, `start`
 * what the counter row held (NaN when the scope had none).
 */
interface Positions {
  next: number;
  readonly start: number;
}

/** The next position, and the counter moved past it. */
function nextPosition(positions: Positions): number {
  const position = positions.next;
  positions.next += 1;
  return position;
}

/** A row to put, before the commit places it: every column but `scope` and `position`. */
type Row = Readonly<Record<string, unknown>>;

/** A write taken over by the store, and the rows it puts, in its order. */
interface OwnedWrite {
  readonly frames: readonly Row[];
  readonly jobs: readonly Row[];
  readonly queues: readonly Row[];
  readonly runs: readonly Row[];
  readonly suspensions: readonly Row[];
  /** The store's own copy of the write: what it writes and what `onCommit` receives. */
  readonly write: Required<
    Pick<
      WorkflowStoreWrite,
      "deleteJobs" | "deleteRunFrames" | "deleteRuns" | "deleteSuspensions"
    >
  > &
    WorkflowStoreWrite;
}

/**
 * `write` as the store's own copy, taken now, and the rows it puts. Each
 * property of the caller's write is read once, by name (`capturedWrite`, as
 * the memory store reads them), and each property of every record in it
 * once:
 * the copy those reads make is what the store checks, writes and hands to
 * `onCommit`, so a getter answering differently a second time changes
 * nothing. Throws a `RangeError` naming the first field SQLite would not give
 * back intact, such as `putRuns[2].queueId` or
 * `putRuns[0].metadata.list[3]`; a field that throws when read rejects the
 * write too.
 */
function owned(write: WorkflowStoreWrite): OwnedWrite {
  const {
    deleteJobs,
    deleteRunFrames,
    deleteRuns,
    deleteSuspensions,
    facts,
    putFrames,
    putJobs,
    putQueues,
    putRuns,
    putSuspensions,
  } = capturedWrite(write);
  const take = <T>(list: string, kind: RecordKind<T>, puts?: readonly T[]) =>
    (puts ?? []).map((record, index) => {
      const at = `${list}[${index}]`;
      try {
        return kept(kind, record);
      } catch (error) {
        if (error instanceof RecordFault) {
          throw new RangeError(
            `SqliteWorkflowStore cannot store ${below(at, error.path)}: ${error.reason}`,
            { cause: error }
          );
        }
        throw error;
      }
    });
  const queues = take("putQueues", QUEUE, putQueues);
  const jobs = take("putJobs", JOB, putJobs);
  const runs = take("putRuns", RUN, putRuns);
  const suspensions = take("putSuspensions", SUSPENSION, putSuspensions);
  const frames = take("putFrames", FRAME, putFrames);
  const records = <T>(list: readonly { record: T }[]) =>
    list.map(({ record }) => record);
  return {
    frames: frames.map(({ record }) => rowOf(FRAME, record)),
    jobs: jobs.map(({ record }) => rowOf(JOB, record)),
    queues: queues.map(({ record }) => rowOf(QUEUE, record)),
    runs: runs.map(({ record, undeclared }) => ({
      ...rowOf(RUN, record),
      undeclared,
    })),
    suspensions: suspensions.map(({ record }) => rowOf(SUSPENSION, record)),
    write: {
      deleteJobs: [...(deleteJobs ?? [])],
      deleteRunFrames: [...(deleteRunFrames ?? [])],
      deleteRuns: [...(deleteRuns ?? [])],
      deleteSuspensions: [...(deleteSuspensions ?? [])],
      // Kept for `onCommit` only; no row holds them.
      ...(facts === undefined ? {} : { facts: detached(facts) }),
      ...(putFrames === undefined ? {} : { putFrames: records(frames) }),
      ...(putJobs === undefined ? {} : { putJobs: records(jobs) }),
      ...(putQueues === undefined ? {} : { putQueues: records(queues) }),
      ...(putRuns === undefined ? {} : { putRuns: records(runs) }),
      ...(putSuspensions === undefined
        ? {}
        : { putSuspensions: records(suspensions) }),
    },
  };
}

/** The columns a record's declared fields fill; an optional field left out is NULL. */
function rowOf<T>(kind: RecordKind<T>, record: T): Row {
  const fields = record as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(kind.fields).map((field) => [
      field,
      Object.hasOwn(fields, field) ? fields[field] : null,
    ])
  );
}

/**
 * Every column but `scope` and `position`, as SQLite returns it, with no
 * mapping by Drizzle, so `#decode` sees JSON as text and NULL as NULL.
 */
function rawColumns(shelf: Shelf<unknown>): Record<string, SQL<unknown>> {
  const {
    position: _position,
    scope: _scope,
    ...columns
  } = getTableColumns(shelf.table);
  return Object.fromEntries(
    Object.entries(columns).map(([field, column]) => [
      field,
      sql<unknown>`${column}`,
    ])
  );
}

/** On a conflicting put, every column but the key and `position` takes the incoming value. */
function replacing(shelf: Shelf<unknown>): Record<string, SQL> {
  const keys = new Set(shelf.keys.map((column) => column.name));
  return Object.fromEntries(
    Object.entries(getTableColumns(shelf.table))
      .filter(
        ([field, column]) => field !== "position" && !keys.has(column.name)
      )
      .map(([field, column]) => [field, excluded(column)])
  );
}

function scopeOf(table: StoreTable): SQLiteColumn {
  return (table as SQLiteTable & { scope: SQLiteColumn }).scope;
}

function positionOf(table: StoreTable): SQLiteColumn {
  return (table as SQLiteTable & { position: SQLiteColumn }).position;
}

/**
 * One condition of a list read, `undefined` for none, or {@link NOTHING}
 * when the query names a value no row can hold, which no row matches.
 */
type Filter = SQL | typeof NOTHING | undefined;

const NOTHING = Symbol("matches nothing");

/** `column = value`; a value no row can hold matches nothing. */
function exact(column: SQLiteColumn, value: string | undefined): Filter {
  if (value === undefined) {
    return undefined;
  }
  return storable(value) ? eq(column, value) : NOTHING;
}

/** `column IN values`; an empty list, or one of values no row can hold, matches nothing. */
function among(
  column: SQLiteColumn,
  values: readonly string[] | undefined
): Filter {
  if (values === undefined) {
    return undefined;
  }
  const held = values.filter(storable);
  return held.length === 0 ? NOTHING : inArray(column, held);
}

/** A JSON column's text parsed, or a refusal naming `column` and what is wrong. */
function parsed(text: unknown, column: string, what: string): unknown {
  if (text === null) {
    return null;
  }
  if (typeof text !== "string") {
    throw unreadable(
      what,
      `column ${column} holds ${describe(text)}, not JSON text`
    );
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw unreadable(
      what,
      `column ${column} holds text that is not JSON (${cause instanceof Error ? cause.message : String(cause)})`,
      cause
    );
  }
}

function unreadable(what: string, fault: string, cause?: unknown): Error {
  return new Error(`SqliteWorkflowStore cannot read ${what}: ${fault}`, {
    cause,
  });
}

/** SQLite's default limit on the parameters one statement binds. */
const MAX_PARAMETERS = 32_766;

/** `items` in order, at most `size` at a time; none when `items` is empty. */
function batches<T>(items: readonly T[], size: number): T[][] {
  const length = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += length) {
    result.push(items.slice(start, start + length));
  }
  return result;
}

/** Runs one statement per batch, each after the one before. */
async function inOrder<T>(
  items: readonly T[],
  run: (item: T) => PromiseLike<unknown>
): Promise<void> {
  for (const item of items) {
    // In sequence: deletes precede puts, and later batches follow earlier ones.
    await run(item);
  }
}

/** The value an `INSERT` proposed for `column`, inside its `ON CONFLICT`. */
function excluded(column: SQLiteColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}
