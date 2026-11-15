import { randomUUID } from "node:crypto";
import { processAlive } from "@foundry/lib/process-identity";
import type { TaskStore, TaskStoreWrite } from "@foundry/tasks";
import { Tasks } from "@foundry/tasks";
import type { TaskTransaction } from "@foundry/tasks/store/sqlite";
import { SqliteTaskStore } from "@foundry/tasks/store/sqlite";
import { and, asc, eq, gt, inArray, max, sql } from "drizzle-orm";
import { busyError } from "~/database/client";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import {
  marblesDeliveryClaims,
  marblesTaskChangeDeliveries,
  marblesTaskChanges,
} from "~/database/tables";
import type { HostDatabaseOptions } from "~/database/workspaces";
import { writeAsHost } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import type {
  PendingQuery,
  StreamItem,
  WorkspaceRecords,
} from "~/lib/events/records";
import {
  EmitListeners,
  PENDING_BATCH,
  RecordsGate,
} from "~/lib/events/records";
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

/**
 * The engine's `WorkspaceRecords` over the Marbles database. Who delivers
 * the workspace's changes is its row of `marbles_delivery_claims`: a claim
 * is a transaction that reads the row's owner and takes it, so two
 * engines, in this process or another, never both deliver; an owner whose
 * process has exited holds nothing.
 */
export class DatabaseWorkspaceRecords implements WorkspaceRecords {
  readonly taskStore: TaskStore;
  readonly #database: StoreDatabase;
  readonly #scope: string;
  /** These records' identity as the delivery claim's owner: one per engine. */
  readonly #owner = randomUUID();
  /** Whether these records took the delivery claim and have not given it up. */
  #claimed = false;
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

  /**
   * Refuse every call from now on, once those under way have settled, then
   * give up the delivery claim if these records still hold it, so the
   * next engine delivers at once, not once this process exits.
   */
  async close(): Promise<void> {
    await this.#gate.close();
    await this.#release();
  }

  async claimDelivery(): Promise<string | undefined> {
    const holder = await this.#call(() => this.#claim());
    if (holder === undefined) {
      this.#claimed = true;
    }
    return holder;
  }

  /** The claim's transaction: who holds it instead, or undefined once these records do. */
  #claim(): Promise<string | undefined> {
    return this.#database.transaction(
      async (transaction): Promise<string | undefined> => {
        const [row] = await transaction
          .select({
            ownerId: marblesDeliveryClaims.ownerId,
            ownerPid: marblesDeliveryClaims.ownerPid,
          })
          .from(marblesDeliveryClaims)
          .where(eq(marblesDeliveryClaims.scope, this.#scope));
        const holder = row?.ownerPid ?? null;
        if (
          holder !== null &&
          row?.ownerId !== this.#owner &&
          processAlive(holder)
        ) {
          return holder === process.pid
            ? "another engine in this process"
            : `pid ${String(holder)}`;
        }
        const owner = { ownerId: this.#owner, ownerPid: process.pid };
        await transaction
          .insert(marblesDeliveryClaims)
          .values({ ...owner, scope: this.#scope })
          .onConflictDoUpdate({
            set: owner,
            target: marblesDeliveryClaims.scope,
          });
        return undefined;
      }
    );
  }

  releaseDelivery(): Promise<void> {
    return this.#call(() => this.#release());
  }

  /** Give up the delivery claim, if these records hold it. */
  async #release(): Promise<void> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; a claim sets it.
    if (!this.#claimed) {
      return;
    }
    this.#claimed = false;
    try {
      await this.#database
        .update(marblesDeliveryClaims)
        .set({ ownerId: null, ownerPid: null })
        .where(
          and(
            eq(marblesDeliveryClaims.scope, this.#scope),
            eq(marblesDeliveryClaims.ownerId, this.#owner)
          )
        );
    } catch (error) {
      throw busyError(error) ?? error;
    }
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

  latest(): Promise<number> {
    return this.#call(async () => {
      const [last] = await this.#database
        .select({ position: max(marblesTaskChanges.position) })
        .from(marblesTaskChanges)
        .where(eq(marblesTaskChanges.scope, this.#scope));
      return last?.position ?? 0;
    });
  }

  pending(query: PendingQuery): Promise<readonly StreamItem[]> {
    if (query.handlers.length === 0) {
      return this.#call(() => Promise.resolve([]));
    }
    return this.#call(async () => {
      const rows = await pendingChanges(this.#database, this.#scope, query);
      return rows.map((row) => ({
        delivered: JSON.parse(row.delivered) as string[],
        id: row.id,
        payload: row.payload,
        position: row.position,
        source: TASKS,
      }));
    });
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
 * The query `pending` runs: one statement, so it reads one state without a
 * transaction, and holds no lock another writer waits for. It walks the
 * workspace's changes by position from `query.after` (the
 * `marbles_task_changes_scope_position` index), keeps those that fewer of
 * `query.handlers` completed than there are handlers (the deliveries'
 * primary key, scope first, answers each count), and stops at
 * `query.limit`. A change every handler completed is passed over but still
 * walked, so the work is the span from `query.after` to the last change
 * returned: delivery passes the position below which its observers have
 * completed everything (`Delivery`'s floor), which keeps that span to
 * what is left to deliver.
 */
export function pendingChanges(
  database: StoreDatabase,
  scope: string,
  query: PendingQuery
) {
  const handlers = [...new Set(query.handlers)];
  const changes = marblesTaskChanges;
  const deliveries = marblesTaskChangeDeliveries;
  const completedBy = and(
    eq(deliveries.scope, changes.scope),
    eq(deliveries.changeId, changes.id),
    inArray(deliveries.handler, handlers)
  );
  return database
    .select({
      delivered: sql<string>`(SELECT json_group_array(${deliveries.handler}) FROM ${deliveries} WHERE ${completedBy})`,
      id: changes.id,
      payload: changes.payload,
      position: changes.position,
    })
    .from(changes)
    .where(
      and(
        eq(changes.scope, scope),
        gt(changes.position, query.after ?? 0),
        sql`(SELECT count(*) FROM ${deliveries} WHERE ${completedBy}) < ${handlers.length}`
      )
    )
    .orderBy(asc(changes.position))
    .limit(query.limit ?? PENDING_BATCH);
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
  const read = await busyAsMarbles(
    readDatabase(stateDatabase(state), async (database) => ({
      value: await work(tasksOver(database, scope)),
    }))
  );
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
  return busyAsMarbles(
    writeAsHost(
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
    )
  );
}

/** `opening`, with a lock SQLite waited too long for while it opened or migrated as a `DatabaseBusyError`. */
async function busyAsMarbles<T>(opening: Promise<T>): Promise<T> {
  try {
    return await opening;
  } catch (error) {
    throw busyError(error) ?? error;
  }
}

function tasksOver(database: StoreDatabase, scope: string): Tasks {
  return new Tasks({
    store: new DatabaseWorkspaceRecords({ database, scope }).taskStore,
  });
}
