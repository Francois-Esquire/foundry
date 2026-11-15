import { Turns } from "@foundry/lib/turns";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import { and, eq, getTableColumns, inArray, max, or, sql } from "drizzle-orm";
import type {
  BaseSQLiteDatabase,
  SQLiteColumn,
  SQLiteTransaction,
} from "drizzle-orm/sqlite-core";
import type {
  Task,
  TaskDependency,
  TaskId,
  TaskSnapshot,
  TaskStoreWrite,
} from "../schema";
import type { TaskStore } from "./index";
import { taskDependencies, tasks } from "./tables";

/**
 * An async Drizzle SQLite database, with or without a relational schema, or a
 * transaction on one. A `drizzle-orm/libsql` database and its transactions
 * both satisfy it, so a host can hand the store either.
 */
export type TaskDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

/** The transaction one `commit` runs in, as `onCommit` receives it. */
export type TaskTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export interface SqliteTaskStoreOptions {
  /** Opened, migrated, and owned by the host; the store never closes it. */
  readonly database: TaskDatabase;
  /**
   * Runs inside the commit's transaction after the store's own statements,
   * so the host can record the change (`write.event`) atomically with it. A
   * throw rolls the whole commit back. It receives the store's own copy of
   * the write, the one its rows were made from, not the caller's object.
   */
  readonly onCommit?: (
    transaction: TaskTransaction,
    write: TaskStoreWrite
  ) => Promise<void>;
  /** The partition this store reads and writes; any nonempty string. */
  readonly scope: string;
}

/** Every column of a task row but `scope` and `position`: exactly a `Task`. */
const {
  position: _position,
  scope: _scope,
  ...taskColumns
} = getTableColumns(tasks);

/** The columns of an edge row that make a `TaskDependency`. */
const dependencyColumns = {
  dependsOnId: taskDependencies.dependsOnId,
  taskId: taskDependencies.taskId,
};

/**
 * On a conflicting put, every task column takes the incoming value except
 * `position`, so a task put again keeps its place.
 */
const replaceTask = Object.fromEntries(
  Object.entries(taskColumns).map(([key, column]) => [key, excluded(column)])
);

/** Why a call from inside the store's own transaction or hook is refused. */
const REENTRY =
  "SqliteTaskStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

/**
 * A `TaskStore` over the host's SQLite database, in the tables from
 * `@foundry/tasks/store/tables`. It behaves as `MemoryTaskStore` does, within
 * its scope. It does not keep `write.event`; `onCommit` receives it.
 *
 * Its calls take turns, as the memory store's do: a call made while a
 * transaction or commit runs waits for it. That keeps two `Tasks` over one
 * store apart in this process, and keeps a `:memory:` database, which has a
 * single connection, from refusing a call while a transaction holds it.
 * Across connections and processes, `transaction` takes the database's
 * write lock (see there).
 */
export class SqliteTaskStore implements TaskStore {
  readonly #database: TaskDatabase;
  readonly #scope: string;
  readonly #onCommit: SqliteTaskStoreOptions["onCommit"];
  readonly #turns = new Turns(REENTRY);

  constructor(options: SqliteTaskStoreOptions) {
    if (options.scope.length === 0 || !storable(options.scope)) {
      throw new RangeError(
        "scope must be a nonempty string with no U+0000 and no lone surrogate"
      );
    }
    this.#database = options.database;
    this.#scope = options.scope;
    this.#onCommit = options.onCommit;
  }

  /**
   * Takes the write as it stands when `commit` is called: one
   * `structuredClone` of the whole write, as the memory store takes it, made
   * before the commit waits its turn. That copy alone is checked, made into
   * every row, and handed to `onCommit`, so a caller changing its write
   * later changes nothing. A write the clone refuses rejects with the
   * clone's error, as in the memory store.
   *
   * Rejects, before writing anything, a write that puts text SQLite would
   * not return intact; see {@link storable}. A delete of such a key does
   * nothing, as no stored row can hold it.
   */
  commit(write: TaskStoreWrite): Promise<void> {
    let owned: TaskStoreWrite;
    try {
      owned = structuredClone(write);
    } catch (error) {
      return Promise.reject(error);
    }
    const field = unstorableField(owned);
    if (field !== undefined) {
      return Promise.reject(
        new RangeError(
          `SqliteTaskStore cannot store ${field}: text holding U+0000 or a lone surrogate (not well-formed UTF-16) does not read back intact from SQLite`
        )
      );
    }
    return this.#turns.run(() =>
      this.#database.transaction(async (transaction) => {
        await this.#deleteTasks(
          transaction,
          (owned.deleteTasks ?? []).filter(storable)
        );
        await this.#deleteDependencies(
          transaction,
          (owned.deleteDependencies ?? []).filter(
            (edge) => storable(edge.taskId) && storable(edge.dependsOnId)
          )
        );
        await this.#putTasks(transaction, owned.putTasks ?? []);
        await this.#putDependencies(transaction, owned.putDependencies ?? []);
        await this.#onCommit?.(transaction, owned);
      })
    );
  }

  /** `null` for an id no row can hold (see {@link storable}). */
  get(id: TaskId): Promise<Task | null> {
    return this.#turns.run(async () => {
      if (!storable(id)) {
        return null;
      }
      const [task] = await this.#database
        .select(taskColumns)
        .from(tasks)
        .where(and(eq(tasks.scope, this.#scope), eq(tasks.id, id)));
      return task ?? null;
    });
  }

  /**
   * Both tables as of one moment: the two reads share one database
   * transaction, so no commit lands between them. On libSQL that
   * transaction begins `BEGIN IMMEDIATE`, as every Drizzle transaction there
   * does, so a snapshot holds the write lock while it reads.
   */
  snapshot(): Promise<TaskSnapshot> {
    return this.#turns.run(() =>
      this.#database.transaction(async (transaction) => {
        const tasksRead = await transaction
          .select(taskColumns)
          .from(tasks)
          .where(eq(tasks.scope, this.#scope))
          .orderBy(tasks.position);
        const dependencies = await transaction
          .select(dependencyColumns)
          .from(taskDependencies)
          .where(eq(taskDependencies.scope, this.#scope))
          .orderBy(taskDependencies.position);
        return { dependencies, tasks: tasksRead };
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
  transaction<T>(work: (view: TaskStore) => Promise<T>): Promise<T> {
    return this.#turns.run(() =>
      this.#database.transaction((transaction) =>
        work(
          new SqliteTaskStore({
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

  async #deleteTasks(
    transaction: TaskTransaction,
    ids: readonly TaskId[]
  ): Promise<void> {
    await inOrder(batches(ids, MAX_PARAMETERS - 1), (batch) =>
      transaction
        .delete(tasks)
        .where(and(eq(tasks.scope, this.#scope), inArray(tasks.id, batch)))
    );
  }

  async #deleteDependencies(
    transaction: TaskTransaction,
    edges: readonly TaskDependency[]
  ): Promise<void> {
    // Each edge is one more `OR`, and each `OR` one more level of depth.
    await inOrder(batches(edges, MAX_EXPRESSION_DEPTH / 2), (batch) =>
      transaction
        .delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.scope, this.#scope),
            or(
              ...batch.map((edge) =>
                and(
                  eq(taskDependencies.taskId, edge.taskId),
                  eq(taskDependencies.dependsOnId, edge.dependsOnId)
                )
              )
            )
          )
        )
    );
  }

  /** A new task takes the next position; one put again keeps its own. */
  async #putTasks(
    transaction: TaskTransaction,
    records: readonly Task[]
  ): Promise<void> {
    const columns = Object.keys(getTableColumns(tasks)).length;
    const first = await this.#nextPosition(transaction, tasks);
    const rows = records.map((task, index) => ({
      ...task,
      position: first + index,
      scope: this.#scope,
    }));
    await inOrder(batches(rows, MAX_PARAMETERS / columns), (batch) =>
      transaction
        .insert(tasks)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceTask,
          target: [tasks.scope, tasks.id],
        })
    );
  }

  async #putDependencies(
    transaction: TaskTransaction,
    edges: readonly TaskDependency[]
  ): Promise<void> {
    const columns = Object.keys(getTableColumns(taskDependencies)).length;
    const first = await this.#nextPosition(transaction, taskDependencies);
    const rows = edges.map((edge, index) => ({
      ...edge,
      position: first + index,
      scope: this.#scope,
    }));
    await inOrder(batches(rows, MAX_PARAMETERS / columns), (batch) =>
      transaction.insert(taskDependencies).values(batch).onConflictDoNothing()
    );
  }

  /**
   * One past the last position in this scope. A row that turns out to exist
   * keeps its own and leaves a gap; only the order of positions matters.
   */
  async #nextPosition(
    transaction: TaskTransaction,
    table: typeof tasks | typeof taskDependencies
  ): Promise<number> {
    const [last] = await transaction
      .select({ position: max(table.position) })
      .from(table)
      .where(eq(table.scope, this.#scope));
    return (last?.position ?? 0) + 1;
  }
}

/** The record fields each table keeps as plain text; JSON text is escaped. */
const taskTextFields = textFields(taskColumns);
const dependencyTextFields = textFields(dependencyColumns);

function textFields(columns: Record<string, SQLiteColumn>): string[] {
  return Object.entries(columns)
    .filter(([, column]) => column.columnType === "SQLiteText")
    .map(([field]) => field);
}

/**
 * Whether SQLite gives `text` back as it was bound. It does not when the text
 * holds U+0000 (libSQL reads it back cut at the NUL) or is not well-formed
 * UTF-16: a lone surrogate is bound as U+FFFD on Node and as nothing on Bun,
 * so it reads back changed, and a key holding one would match another key's
 * row. JSON columns are exempt: JSON escapes both.
 */
function storable(text: string): boolean {
  return text.isWellFormed() && !text.includes("\u0000");
}

/**
 * The first plain-text field a write would put that is not
 * {@link storable}, as a path such as `putTasks[2].title`. A storage limit
 * of this store, not a rule of the domain.
 */
function unstorableField(write: TaskStoreWrite): string | undefined {
  const puts = [
    ["putTasks", write.putTasks ?? [], taskTextFields],
    ["putDependencies", write.putDependencies ?? [], dependencyTextFields],
  ] as const;
  for (const [list, records, fields] of puts) {
    for (const [index, record] of records.entries()) {
      const values: Readonly<Record<string, unknown>> = record;
      const field = fields.find((name) => {
        const value = values[name];
        return typeof value === "string" && !storable(value);
      });
      if (field !== undefined) {
        return `${list}[${index}].${field}`;
      }
    }
  }
}

/** SQLite's default limit on the parameters one statement binds. */
const MAX_PARAMETERS = 32_766;

/** SQLite's default limit on the depth of one expression. */
const MAX_EXPRESSION_DEPTH = 1000;

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
