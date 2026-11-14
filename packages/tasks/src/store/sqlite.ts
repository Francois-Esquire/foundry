import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import { and, eq, getTableColumns, inArray, or, sql } from "drizzle-orm";
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
   * throw rolls the whole commit back.
   */
  readonly onCommit?: (
    transaction: TaskTransaction,
    write: TaskStoreWrite
  ) => Promise<void>;
  /** The partition this store reads and writes; any nonempty string. */
  readonly scope: string;
}

/** Every column of a task row except `scope`: exactly a `Task`. */
const { scope: _scope, ...taskColumns } = getTableColumns(tasks);

/** On a conflicting put, every task column takes the incoming value. */
const replaceTask = Object.fromEntries(
  Object.entries(taskColumns).map(([key, column]) => [key, excluded(column)])
);

/**
 * A `TaskStore` over the host's SQLite database, in the tables from
 * `@foundry/tasks/store/tables`. It behaves as `MemoryTaskStore` does, within
 * its scope. It does not keep `write.event`; `onCommit` receives it.
 */
export class SqliteTaskStore implements TaskStore {
  readonly #database: TaskDatabase;
  readonly #scope: string;
  readonly #onCommit: SqliteTaskStoreOptions["onCommit"];

  constructor(options: SqliteTaskStoreOptions) {
    if (options.scope.length === 0) {
      throw new RangeError("scope must be a nonempty string");
    }
    this.#database = options.database;
    this.#scope = options.scope;
    this.#onCommit = options.onCommit;
  }

  commit(write: TaskStoreWrite): Promise<void> {
    return this.#database.transaction(async (transaction) => {
      await this.#deleteTasks(transaction, write.deleteTasks ?? []);
      await this.#deleteDependencies(
        transaction,
        write.deleteDependencies ?? []
      );
      await this.#putTasks(transaction, write.putTasks ?? []);
      await this.#putDependencies(transaction, write.putDependencies ?? []);
      await this.#onCommit?.(transaction, write);
    });
  }

  async get(id: TaskId): Promise<Task | null> {
    const [task] = await this.#database
      .select(taskColumns)
      .from(tasks)
      .where(and(eq(tasks.scope, this.#scope), eq(tasks.id, id)));
    return task ?? null;
  }

  /**
   * Two reads, not one transaction: Drizzle's libSQL driver opens every
   * transaction for writing. Another connection's commit can land between
   * them.
   */
  async snapshot(): Promise<TaskSnapshot> {
    // `rowid` is the order rows were first inserted; an upsert keeps it.
    const tasksRead = await this.#database
      .select(taskColumns)
      .from(tasks)
      .where(eq(tasks.scope, this.#scope))
      .orderBy(sql`rowid`);
    const dependencies = await this.#database
      .select({
        dependsOnId: taskDependencies.dependsOnId,
        taskId: taskDependencies.taskId,
      })
      .from(taskDependencies)
      .where(eq(taskDependencies.scope, this.#scope))
      .orderBy(sql`rowid`);
    return { dependencies, tasks: tasksRead };
  }

  async #deleteTasks(
    transaction: TaskTransaction,
    ids: readonly TaskId[]
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await transaction
      .delete(tasks)
      .where(and(eq(tasks.scope, this.#scope), inArray(tasks.id, [...ids])));
  }

  async #deleteDependencies(
    transaction: TaskTransaction,
    edges: readonly TaskDependency[]
  ): Promise<void> {
    if (edges.length === 0) {
      return;
    }
    await transaction
      .delete(taskDependencies)
      .where(
        and(
          eq(taskDependencies.scope, this.#scope),
          or(
            ...edges.map((edge) =>
              and(
                eq(taskDependencies.taskId, edge.taskId),
                eq(taskDependencies.dependsOnId, edge.dependsOnId)
              )
            )
          )
        )
      );
  }

  /** One statement; rows insert in order, so a new task's rowid is its place. */
  async #putTasks(
    transaction: TaskTransaction,
    records: readonly Task[]
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }
    await transaction
      .insert(tasks)
      .values(records.map((task) => ({ ...task, scope: this.#scope })))
      .onConflictDoUpdate({
        set: replaceTask,
        target: [tasks.scope, tasks.id],
      });
  }

  async #putDependencies(
    transaction: TaskTransaction,
    edges: readonly TaskDependency[]
  ): Promise<void> {
    if (edges.length === 0) {
      return;
    }
    await transaction
      .insert(taskDependencies)
      .values(edges.map((edge) => ({ ...edge, scope: this.#scope })))
      .onConflictDoNothing();
  }
}

/** The value an `INSERT` proposed for `column`, inside its `ON CONFLICT`. */
function excluded(column: SQLiteColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}
