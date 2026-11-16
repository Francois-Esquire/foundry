import { randomUUID } from "node:crypto";
import { processAlive } from "@foundry/lib/file-lock";
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

export class TaskStorageError extends Error {
  override readonly name = "TaskStorageError";
}

export interface DatabaseWorkspaceRecordsOptions {
  readonly database: StoreDatabase;
  readonly scope: string;
}

export class DatabaseWorkspaceRecords implements WorkspaceRecords {
  readonly taskStore: TaskStore;
  readonly #database: StoreDatabase;
  readonly #scope: string;
  readonly #owner = randomUUID();
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

  async close(): Promise<void> {
    await this.#gate.close();
    await this.#release();
  }

  claimDelivery(): Promise<string | undefined> {
    return this.#call(async () => {
      const holder = await this.#claim();
      if (holder === undefined) {
        this.#claimed = true;
      }
      return holder;
    });
  }

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

  async #release(): Promise<void> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; a claim sets it.
    if (!this.#claimed) {
      return;
    }
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
    this.#claimed = false;
  }

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

function storageError(error: unknown): Error | undefined {
  return busyError(error);
}

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
