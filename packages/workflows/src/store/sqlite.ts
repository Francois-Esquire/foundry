import {
  assertScope,
  batches,
  joinFieldPath,
  RecordFault,
  replacing,
  SQLITE_MAX_PARAMETERS,
  type SqliteDatabase,
  type SqliteTransaction,
  storableText,
} from "@foundry/lib/sqlite";
import { Turns } from "@foundry/lib/turns";
import type { SQL } from "drizzle-orm";
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
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
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
  describe,
  FRAME,
  JOB,
  kept,
  QUEUE,
  RUN,
  SUSPENSION,
} from "./sqlite-records";
import {
  workflowJobs,
  workflowPositions,
  workflowQueues,
  workflowRunFrames,
  workflowRuns,
  workflowSuspensions,
} from "./tables";

export type WorkflowDatabase = SqliteDatabase;

export type WorkflowTransaction = SqliteTransaction;

export interface SqliteWorkflowStoreOptions {
  readonly database: WorkflowDatabase;
  readonly durability?: WorkflowStoreDurability;
  readonly onCommit?: (
    transaction: WorkflowTransaction,
    write: WorkflowStoreWrite
  ) => Promise<void>;
  readonly scope: string;
}

const REENTRY =
  "SqliteWorkflowStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

interface Shelf<T> {
  readonly keys: readonly SQLiteColumn[];
  readonly kind: RecordKind<T>;
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

export class SqliteWorkflowStore implements WorkflowStore {
  readonly durability: WorkflowStoreDurability;
  readonly #database: WorkflowDatabase;
  readonly #scope: string;
  readonly #onCommit: SqliteWorkflowStoreOptions["onCommit"];
  readonly #turns = new Turns(REENTRY);

  constructor(options: SqliteWorkflowStoreOptions) {
    assertScope(options.scope);
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

  commit(write: WorkflowStoreWrite): Promise<void> {
    let taken: OwnedWrite;
    try {
      taken = owned(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() =>
      this.#database.transaction(async (transaction) => {
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

  getJob(id: string): Promise<JobRecord | null> {
    return this.#get(JOBS, [id]);
  }

  getQueue(id: string): Promise<QueueRecord | null> {
    return this.#get(QUEUES, [id]);
  }

  getRun(id: string): Promise<RunRecord | null> {
    return this.#get(RUNS, [id]);
  }

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
      if (!key.every(storableText)) {
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
    for (const batch of batches(
      ids.filter(storableText),
      SQLITE_MAX_PARAMETERS - 1
    )) {
      await transaction
        .delete(table)
        .where(and(eq(scopeOf(table), this.#scope), inArray(column, batch)));
    }
  }

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
    for (const batch of batches(placed, SQLITE_MAX_PARAMETERS / columns)) {
      await transaction
        .insert(shelf.table)
        .values(batch as never[])
        .onConflictDoUpdate({
          set: replacing(getTableColumns(shelf.table), [
            positionOf(shelf.table),
            ...shelf.keys,
          ]),
          target: [...shelf.keys],
        });
    }
  }

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

const TABLES: readonly StoreTable[] = [
  workflowQueues,
  workflowJobs,
  workflowRuns,
  workflowSuspensions,
  workflowRunFrames,
];

interface Positions {
  next: number;
  readonly start: number;
}

function nextPosition(positions: Positions): number {
  const position = positions.next;
  positions.next += 1;
  return position;
}

type Row = Readonly<Record<string, unknown>>;

interface OwnedWrite {
  readonly frames: readonly Row[];
  readonly jobs: readonly Row[];
  readonly queues: readonly Row[];
  readonly runs: readonly Row[];
  readonly suspensions: readonly Row[];
  readonly write: Required<
    Pick<
      WorkflowStoreWrite,
      "deleteJobs" | "deleteRunFrames" | "deleteRuns" | "deleteSuspensions"
    >
  > &
    WorkflowStoreWrite;
}

function owned(write: WorkflowStoreWrite): OwnedWrite {
  const {
    deleteJobs,
    deleteRunFrames,
    deleteRuns,
    deleteSuspensions,
    events,
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
            `SqliteWorkflowStore cannot store ${joinFieldPath(at, error.path)}: ${error.reason}`,
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
      ...(events === undefined ? {} : { events: detached(events) }),
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

function rowOf<T>(kind: RecordKind<T>, record: T): Row {
  const fields = record as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(kind.fields).map((field) => [
      field,
      Object.hasOwn(fields, field) ? fields[field] : null,
    ])
  );
}

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

function scopeOf(table: StoreTable): SQLiteColumn {
  return (table as SQLiteTable & { scope: SQLiteColumn }).scope;
}

function positionOf(table: StoreTable): SQLiteColumn {
  return (table as SQLiteTable & { position: SQLiteColumn }).position;
}

type Filter = SQL | typeof NOTHING | undefined;

const NOTHING = Symbol("matches nothing");

function exact(column: SQLiteColumn, value: string | undefined): Filter {
  if (value === undefined) {
    return undefined;
  }
  return storableText(value) ? eq(column, value) : NOTHING;
}

function among(
  column: SQLiteColumn,
  values: readonly string[] | undefined
): Filter {
  if (values === undefined) {
    return undefined;
  }
  const held = values.filter(storableText);
  return held.length === 0 ? NOTHING : inArray(column, held);
}

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
