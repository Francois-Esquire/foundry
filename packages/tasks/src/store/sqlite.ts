import { ownedWrite } from "@foundry/lib/plain-json";
import {
  assertScope,
  batches,
  replacing,
  SQLITE_MAX_PARAMETERS,
  type SqliteDatabase,
  type SqliteTransaction,
  storableText,
  UNSTORABLE_TEXT,
} from "@foundry/lib/sqlite";
import { Turns } from "@foundry/lib/turns";
import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNull,
  max,
  or,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type {
  Task,
  TaskDependency,
  TaskId,
  TaskSnapshot,
  TaskStoreWrite,
} from "../schema";
import { edgeKey } from "../schema";
import type { TaskStore, TaskStoreListQuery } from "./index";
import { taskDependencies, tasks } from "./tables";

export type TaskDatabase = SqliteDatabase;

export type TaskTransaction = SqliteTransaction;

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

const replaceTask = replacing(taskColumns);

const REENTRY =
  "SqliteTaskStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

export class SqliteTaskStore implements TaskStore {
  readonly #database: TaskDatabase;
  readonly #scope: string;
  readonly #onCommit: SqliteTaskStoreOptions["onCommit"];
  readonly #turns = new Turns(REENTRY);

  constructor(options: SqliteTaskStoreOptions) {
    assertScope(options.scope);
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
          `SqliteTaskStore cannot store ${field}: ${UNSTORABLE_TEXT}`
        )
      );
    }
    return this.#turns.run(() =>
      this.#database.transaction(async (transaction) => {
        await this.#deleteTasks(
          transaction,
          (owned.deleteTasks ?? []).filter(storableText)
        );
        await this.#deleteDependencies(
          transaction,
          (owned.deleteDependencies ?? []).filter(
            (edge) =>
              storableText(edge.taskId) && storableText(edge.dependsOnId)
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
      if (!storableText(id)) {
        return null;
      }
      const [task] = await this.#database
        .select(taskColumns)
        .from(tasks)
        .where(and(eq(tasks.scope, this.#scope), eq(tasks.id, id)));
      return task ?? null;
    });
  }

  list(query: TaskStoreListQuery = {}): Promise<readonly Task[]> {
    return this.#turns.run(() =>
      this.#database.transaction(async (transaction) => {
        if (
          (query.status !== undefined && !storableText(query.status)) ||
          (query.parentId !== undefined &&
            query.parentId !== null &&
            !storableText(query.parentId))
        ) {
          return [];
        }
        let parentCondition:
          | ReturnType<typeof eq>
          | ReturnType<typeof isNull>
          | undefined;
        if (query.parentId === null) {
          parentCondition = isNull(tasks.parentId);
        } else if (query.parentId !== undefined) {
          parentCondition = eq(tasks.parentId, query.parentId);
        }
        return await transaction
          .select(taskColumns)
          .from(tasks)
          .where(
            and(
              eq(tasks.scope, this.#scope),
              query.status === undefined
                ? undefined
                : eq(tasks.status, query.status),
              parentCondition
            )
          )
          .orderBy(tasks.position);
      })
    );
  }

  children(parentId: TaskId): Promise<readonly Task[]> {
    return this.list({ parentId });
  }

  dependenciesOf(ids: readonly TaskId[]): Promise<readonly TaskDependency[]> {
    return this.#turns.run(() =>
      this.#database.transaction(async (transaction) => {
        const valid = [...new Set(ids)].filter(storableText);
        if (valid.length === 0) {
          return [];
        }
        const seen = new Map<
          string,
          { readonly edge: TaskDependency; readonly position: number }
        >();
        const batchSize = Math.floor((SQLITE_MAX_PARAMETERS - 1) / 2);
        for (const batch of batches(valid, batchSize)) {
          const rows = await transaction
            .select({
              dependsOnId: taskDependencies.dependsOnId,
              position: taskDependencies.position,
              taskId: taskDependencies.taskId,
            })
            .from(taskDependencies)
            .where(
              and(
                eq(taskDependencies.scope, this.#scope),
                or(
                  inArray(taskDependencies.taskId, batch),
                  inArray(taskDependencies.dependsOnId, batch)
                )
              )
            )
            .orderBy(taskDependencies.position);
          for (const row of rows) {
            const edge: TaskDependency = {
              dependsOnId: row.dependsOnId,
              taskId: row.taskId,
            };
            const key = edgeKey(edge);
            if (!seen.has(key)) {
              seen.set(key, { edge, position: row.position });
            }
          }
        }
        return [...seen.values()]
          .sort((a, b) => a.position - b.position)
          .map((entry) => entry.edge);
      })
    );
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
    for (const batch of batches(ids, SQLITE_MAX_PARAMETERS - 1)) {
      await transaction
        .delete(tasks)
        .where(and(eq(tasks.scope, this.#scope), inArray(tasks.id, batch)));
    }
  }

  async #deleteDependencies(
    transaction: TaskTransaction,
    edges: readonly TaskDependency[]
  ): Promise<void> {
    for (const batch of batches(edges, MAX_EXPRESSION_DEPTH / 2)) {
      await transaction
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
        );
    }
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
    for (const batch of batches(rows, SQLITE_MAX_PARAMETERS / columns)) {
      await transaction
        .insert(tasks)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceTask,
          target: [tasks.scope, tasks.id],
        });
    }
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
    for (const batch of batches(rows, SQLITE_MAX_PARAMETERS / columns)) {
      await transaction
        .insert(taskDependencies)
        .values(batch)
        .onConflictDoNothing();
    }
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
        return typeof value === "string" && !storableText(value);
      });
      if (field !== undefined) {
        return `${list}[${index}].${field}`;
      }
    }
  }
}

const MAX_EXPRESSION_DEPTH = 1000;
