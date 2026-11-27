import { sameProcess } from "@foundry/lib/process-identity";
import type { TaskStore } from "@foundry/tasks";
import { Tasks } from "@foundry/tasks";
import { SqliteTaskStore } from "@foundry/tasks/store/sqlite";
import { and, eq } from "drizzle-orm";
import { aroundCalls, busyError } from "~/database/busy";
import { ChangeRecorder, DatabaseChangeLog } from "~/database/changes";
import { readDatabase } from "~/database/open";
import {
  CHANGED,
  claimJudged,
  heldBy,
  NO_OWNER,
  ownedHere,
  sameOwnerColumns,
} from "~/database/owner";
import { marblesDeliveryClaims } from "~/database/tables";
import type { StoreDatabase } from "~/database/types";
import type { HostDatabaseOptions } from "~/database/workspaces";
import { writeAsHost } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import type { ChangeLog } from "~/lib/events/log";
import type { WorkspaceRecords } from "~/lib/events/records";
import { RecordsGate } from "~/lib/events/records";
import { sourceKey, TASKS } from "~/lib/events/source";
import { NODE_OWNER_LIVENESS } from "~/lib/node-host-liveness";
import type { OwnerLiveness } from "~/lib/owner-liveness";

const TASKS_KEY = sourceKey(TASKS) ?? "tasks";

export class TaskStorageError extends Error {
  override readonly name = "TaskStorageError";
}

export interface DatabaseWorkspaceRecordsOptions {
  readonly changes?: ChangeRecorder;
  readonly database: StoreDatabase;
  readonly liveness?: OwnerLiveness;
  readonly scope: string;
}

export class DatabaseWorkspaceRecords implements WorkspaceRecords {
  readonly taskStore: TaskStore;
  readonly log: ChangeLog;
  readonly changes: ChangeRecorder;
  readonly #database: StoreDatabase;
  readonly #scope: string;
  readonly #liveness: OwnerLiveness;
  readonly #owner = crypto.randomUUID();
  #claimed = false;
  readonly #gate = new RecordsGate();

  constructor(options: DatabaseWorkspaceRecordsOptions) {
    const { database, scope } = options;
    this.#database = database;
    this.#scope = scope;
    this.#liveness = options.liveness ?? NODE_OWNER_LIVENESS;
    const changes = options.changes ?? new ChangeRecorder(scope);
    if (changes.scope !== scope) {
      throw new Error(
        `the change recorder of workspace ${changes.scope} cannot record workspace ${scope}'s tasks`
      );
    }
    this.changes = changes;
    this.log = aroundCalls(
      new DatabaseChangeLog(database, scope, this.#owner),
      (call) => this.#call(call)
    );
    const store = changes.causing(
      new SqliteTaskStore({
        database,
        onCommit: (transaction, write) =>
          changes.record(transaction, TASKS_KEY, write.events),
        scope,
      })
    );
    const committing = <T>(call: () => Promise<T>): Promise<T> =>
      this.#call(call);
    this.taskStore = {
      children: (parentId) => this.#call(() => store.children(parentId)),
      commit: (write) => committing(() => storing(store.commit(write))),
      dependenciesOf: (ids) => this.#call(() => store.dependenciesOf(ids)),
      get: (id) => this.#call(() => store.get(id)),
      list: (query) => this.#call(() => store.list(query)),
      snapshot: () => this.#call(() => store.snapshot()),
      transaction: (work) =>
        committing(() =>
          store.transaction((view) =>
            work({
              ...(view.children === undefined
                ? {}
                : {
                    children: (parentId) =>
                      view.children?.(parentId) ?? Promise.resolve([]),
                  }),
              commit: (write) => storing(view.commit(write)),
              ...(view.dependenciesOf === undefined
                ? {}
                : {
                    dependenciesOf: (ids) =>
                      view.dependenciesOf?.(ids) ?? Promise.resolve([]),
                  }),
              get: (id) => view.get(id),
              ...(view.list === undefined
                ? {}
                : {
                    list: (query) => view.list?.(query) ?? Promise.resolve([]),
                  }),
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
    const look = (database: StoreDatabase) =>
      database
        .select({
          ownerId: marblesDeliveryClaims.ownerId,
          ownerPid: marblesDeliveryClaims.ownerPid,
          ownerStarted: marblesDeliveryClaims.ownerStarted,
        })
        .from(marblesDeliveryClaims)
        .where(eq(marblesDeliveryClaims.scope, this.#scope))
        .then(([row]) => row);
    return claimJudged(
      () => look(this.#database),
      (seen) =>
        seen === undefined || seen.ownerId === this.#owner
          ? null
          : heldBy(seen, this.#liveness),
      (seen, holder) =>
        this.#database.transaction(
          async (transaction): Promise<string | undefined | typeof CHANGED> => {
            if (!sameOwnerColumns(await look(transaction), seen)) {
              return CHANGED;
            }
            if (holder !== null) {
              return sameProcess(holder, this.#liveness.identity())
                ? "another engine in this process"
                : `pid ${String(holder.pid)}`;
            }
            const owner = ownedHere(this.#owner, this.#liveness);
            await transaction
              .insert(marblesDeliveryClaims)
              .values({ ...owner, scope: this.#scope })
              .onConflictDoUpdate({
                set: owner,
                target: marblesDeliveryClaims.scope,
              });
            return undefined;
          }
        ),
      "an owner that kept changing"
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
        .set(NO_OWNER)
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

  watch(listener: () => void): () => void {
    return this.changes.watch(listener);
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
