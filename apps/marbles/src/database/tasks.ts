import { randomUUID } from "node:crypto";
import type { TaskStore, TaskStoreWrite } from "@foundry/tasks";
import { Tasks } from "@foundry/tasks";
import type { TaskTransaction } from "@foundry/tasks/store/sqlite";
import { SqliteTaskStore } from "@foundry/tasks/store/sqlite";
import { and, asc, eq, max } from "drizzle-orm";
import { busyError } from "~/database/client";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import {
  marblesTaskChangeDeliveries,
  marblesTaskChanges,
} from "~/database/tables";
import type { HostDatabaseOptions } from "~/database/workspaces";
import { writeAsHost } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import type { StreamItem, WorkspaceRecords } from "~/lib/events/records";
import { EmitListeners, RecordsGate } from "~/lib/events/records";
import { TASKS } from "~/lib/events/source";

/**
 * A workspace's tasks in the Marbles database: the `@foundry/tasks` rows
 * scoped by the workspace id, and Marbles' record of every change they
 * committed (`marbles_task_changes`), which delivery reads back for the
 * workspace's observers.
 *
 * The change is written by `SqliteTaskStore`'s `onCommit` hook, on the
 * transaction the hook is handed, so a change and its row commit or roll
 * back together. That hook (`recordChange`) is the one seam where anything
 * that keeps a record of task changes, such as an outbox, belongs.
 */

/** A change the Marbles database cannot store as it is. */
export class TaskStorageError extends Error {
  override readonly name = "TaskStorageError";
}

export interface DatabaseWorkspaceRecordsOptions {
  /** The database or one of its transactions; the host opens and closes it. */
  readonly database: StoreDatabase;
  /** The workspace id. */
  readonly scope: string;
}

/** The engine's `WorkspaceRecords` over the Marbles database. */
export class DatabaseWorkspaceRecords implements WorkspaceRecords {
  readonly taskStore: TaskStore;
  readonly #database: StoreDatabase;
  readonly #scope: string;
  readonly #gate = new RecordsGate();
  readonly #listeners = new EmitListeners();

  constructor(options: DatabaseWorkspaceRecordsOptions) {
    const { database, scope } = options;
    this.#database = database;
    this.#scope = scope;
    let recorded = false;
    const store = new SqliteTaskStore({
      database,
      onCommit: async (transaction, write) => {
        if (await recordChange(transaction, scope, write)) {
          recorded = true;
        }
      },
      scope,
    });
    /** Run a call that may commit, then tell the watchers once it settles. */
    const committing = <T>(call: () => Promise<T>): Promise<T> =>
      this.#call(async () => {
        try {
          return await call();
        } finally {
          if (recorded) {
            recorded = false;
            this.#listeners.emit();
          }
        }
      });
    this.taskStore = {
      commit: (write) => committing(() => storing(store.commit(write))),
      get: (id) => this.#call(() => store.get(id)),
      snapshot: () => this.#call(() => store.snapshot()),
      transaction: (work) =>
        committing(() =>
          store.transaction((view) =>
            work({
              commit: (write) => storing(view.commit(write)),
              get: (id) => view.get(id),
              snapshot: () => view.snapshot(),
            })
          )
        ),
    };
  }

  close(): Promise<void> {
    return this.#gate.close();
  }

  /** Only for a change that is recorded; a hash already there stays one row. */
  deliver(id: string, hash: string): Promise<void> {
    return this.#call(() =>
      this.#database.transaction(async (transaction) => {
        const [change] = await transaction
          .select({ id: marblesTaskChanges.id })
          .from(marblesTaskChanges)
          .where(
            and(
              eq(marblesTaskChanges.scope, this.#scope),
              eq(marblesTaskChanges.id, id)
            )
          );
        if (change === undefined) {
          return;
        }
        await transaction
          .insert(marblesTaskChangeDeliveries)
          .values({ changeId: id, handler: hash, scope: this.#scope })
          .onConflictDoNothing();
      })
    );
  }

  /** Both tables as of one moment: the two reads share one transaction. */
  pending(): Promise<readonly StreamItem[]> {
    return this.#call(() =>
      this.#database.transaction(async (transaction) => {
        const changes = await transaction
          .select({
            id: marblesTaskChanges.id,
            payload: marblesTaskChanges.payload,
          })
          .from(marblesTaskChanges)
          .where(eq(marblesTaskChanges.scope, this.#scope))
          .orderBy(asc(marblesTaskChanges.position));
        const deliveries = await transaction
          .select({
            changeId: marblesTaskChangeDeliveries.changeId,
            handler: marblesTaskChangeDeliveries.handler,
          })
          .from(marblesTaskChangeDeliveries)
          .where(eq(marblesTaskChangeDeliveries.scope, this.#scope));
        const delivered = new Map<string, string[]>();
        for (const { changeId, handler } of deliveries) {
          delivered.set(changeId, [
            ...(delivered.get(changeId) ?? []),
            handler,
          ]);
        }
        return changes.map(({ id, payload }) => ({
          delivered: delivered.get(id) ?? [],
          id,
          payload,
          source: TASKS,
        }));
      })
    );
  }

  watch(listener: () => void): () => void {
    return this.#listeners.add(listener);
  }

  /** Run `call` unless closed, and say what went wrong in the database's terms. */
  #call<T>(call: () => Promise<T>): Promise<T> {
    return this.#gate.run(async () => {
      try {
        return await call();
      } catch (error) {
        throw storageError(error) ?? error;
      }
    });
  }
}

/**
 * Record the change `write` carries, if it carries one, in the commit's own
 * `transaction`: never through a store, which would wait on the commit
 * that is running this. Whether a change was recorded.
 */
async function recordChange(
  transaction: TaskTransaction,
  scope: string,
  write: TaskStoreWrite
): Promise<boolean> {
  if (write.event === undefined) {
    return false;
  }
  const [last] = await transaction
    .select({ position: max(marblesTaskChanges.position) })
    .from(marblesTaskChanges)
    .where(eq(marblesTaskChanges.scope, scope));
  await transaction.insert(marblesTaskChanges).values({
    id: randomUUID(),
    payload: write.event,
    position: (last?.position ?? 0) + 1,
    scope,
  });
  return true;
}

/**
 * A commit, with the task store's one refusal of a write, text that would
 * not read back intact (a `RangeError` naming the field), as a
 * `TaskStorageError`.
 */
async function storing(commit: Promise<void>): Promise<void> {
  try {
    await commit;
  } catch (error) {
    if (error instanceof RangeError) {
      throw new TaskStorageError(
        `this change cannot be stored in the Marbles database: ${error.message}`,
        { cause: error }
      );
    }
    throw error;
  }
}

/** A lock the database waited too long for, as a `DatabaseBusyError`. */
function storageError(error: unknown): Error | undefined {
  return busyError(error);
}

/**
 * Run `work` on a workspace's tasks for a command that only reads them:
 * through a read-only connection that never creates, migrates or changes
 * the database. With no database, or nothing migrated into it, there are
 * no tasks yet, and `work` reads an empty backlog in memory.
 */
export async function readTasks<T>(
  state: string,
  scope: string,
  work: (tasks: Tasks) => Promise<T>
): Promise<T> {
  const read = await readDatabase(stateDatabase(state), async (database) => ({
    value: await work(tasksOver(database, scope)),
  }));
  return read === undefined ? work(new Tasks()) : read.value;
}

/**
 * Run `work` on a workspace's tasks for a command that changes them,
 * whether or not a Marbles process runs: as a writer under the state
 * root's lock rule (`writeAsHost`), which makes and migrates the database
 * when no process holds the state root.
 */
export function changeTasks<T>(
  state: string,
  scope: string,
  work: (tasks: Tasks) => Promise<T>,
  options: HostDatabaseOptions = {}
): Promise<T> {
  return writeAsHost(
    state,
    async (database) => {
      const records = new DatabaseWorkspaceRecords({ database, scope });
      try {
        return await work(new Tasks({ store: records.taskStore }));
      } finally {
        await records.close();
      }
    },
    options
  );
}

function tasksOver(database: StoreDatabase, scope: string): Tasks {
  return new Tasks({
    store: new DatabaseWorkspaceRecords({ database, scope }).taskStore,
  });
}
