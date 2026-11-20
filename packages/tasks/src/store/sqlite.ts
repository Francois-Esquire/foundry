import { ownedWrite } from "@foundry/lib/plain-json";
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

export type TaskDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

export type TaskTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export interface SqliteTaskStoreOptions {
  readonly database: TaskDatabase;
  readonly onCommit?: (
    transaction: TaskTransaction,
    write: TaskStoreWrite
  ) => Promise<void>;
  readonly scope: string;
}

const {
  position: _position,
  scope: _scope,
  ...taskColumns
} = getTableColumns(tasks);

const dependencyColumns = {
  dependsOnId: taskDependencies.dependsOnId,
  taskId: taskDependencies.taskId,
};

const replaceTask = Object.fromEntries(
  Object.entries(taskColumns).map(([key, column]) => [key, excluded(column)])
);

const REENTRY =
  "SqliteTaskStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

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

  commit(write: TaskStoreWrite): Promise<void> {
    let owned: TaskStoreWrite;
    try {
      owned = ownedWrite(write);
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

const taskTextFields = textFields(taskColumns);
const dependencyTextFields = textFields(dependencyColumns);

function textFields(columns: Record<string, SQLiteColumn>): string[] {
  return Object.entries(columns)
    .filter(([, column]) => column.columnType === "SQLiteText")
    .map(([field]) => field);
}

function storable(text: string): boolean {
  return text.isWellFormed() && !text.includes("\u0000");
}

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

const MAX_PARAMETERS = 32_766;

const MAX_EXPRESSION_DEPTH = 1000;

function batches<T>(items: readonly T[], size: number): T[][] {
  const length = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += length) {
    result.push(items.slice(start, start + length));
  }
  return result;
}

async function inOrder<T>(
  items: readonly T[],
  run: (item: T) => PromiseLike<unknown>
): Promise<void> {
  for (const item of items) {
    await run(item);
  }
}

function excluded(column: SQLiteColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}
