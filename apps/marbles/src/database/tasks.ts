import { randomUUID } from "node:crypto";
import { sameProcess, thisProcess } from "@foundry/lib/process-identity";
import type { TaskStore } from "@foundry/tasks";
import { Tasks } from "@foundry/tasks";
import { SqliteTaskStore } from "@foundry/tasks/store/sqlite";
import { and, eq } from "drizzle-orm";
import { aroundCalls } from "~/database/busy";
import { ChangeRecorder, DatabaseChangeLog } from "~/database/changes";
import { busyError } from "~/database/client";
import type { StoreDatabase } from "~/database/open";
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
import type { HostDatabaseOptions } from "~/database/workspaces";
import { writeAsHost } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import type { ChangeLog } from "~/lib/events/log";
import type { WorkspaceRecords } from "~/lib/events/records";
import { RecordsGate } from "~/lib/events/records";
import { sourceKey, TASKS } from "~/lib/events/source";

/**
 * A workspace's tasks in the Marbles database: the `@foundry/tasks` rows
 * scoped by the workspace id, and the workspace's change log
 * (`database/changes.ts`), which every store of the workspace writes its
 * change facts to and delivery reads back for the workspace's observers.
 *
 * A task write's facts are recorded by `SqliteTaskStore`'s `onCommit`
 * hook, on the transaction the hook is handed, so a change and its facts
 * commit or roll back together, as every other store's do.
 */

const TASKS_KEY = sourceKey(TASKS) ?? "tasks";

/** A change the Marbles database cannot store as it is. */
export class TaskStorageError extends Error {
  override readonly name = "TaskStorageError";
}

export interface DatabaseWorkspaceRecordsOptions {
  /**
   * What the workspace's stores in this process record their facts
   * through, shared by all of them; one of these records' own when
   * omitted. Its scope is the workspace id.
   */
  readonly changes?: ChangeRecorder;
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
  readonly log: ChangeLog;
  /** What every store of the workspace records its facts through. */
  readonly changes: ChangeRecorder;
  readonly #database: StoreDatabase;
  readonly #scope: string;
  /** These records' identity as the delivery claim's owner: one per engine. */
  readonly #owner = randomUUID();
  /** Whether these records took the delivery claim and have not given it up. */
  #claimed = false;
  readonly #gate = new RecordsGate();

  constructor(options: DatabaseWorkspaceRecordsOptions) {
    const { database, scope } = options;
    this.#database = database;
    this.#scope = scope;
    const changes = options.changes ?? new ChangeRecorder(scope);
    if (changes.scope !== scope) {
      throw new Error(
        `the change recorder of workspace ${changes.scope} cannot record workspace ${scope}'s tasks`
      );
    }
    this.changes = changes;
    this.log = aroundCalls(new DatabaseChangeLog(database, scope), (call) =>
      this.#call(call)
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

  claimDelivery(): Promise<string | undefined> {
    // The flag is set inside the call, so `close`, which waits for the
    // calls under way, always finds a claim it must give up.
    return this.#call(async () => {
      const holder = await this.#claim();
      if (holder === undefined) {
        this.#claimed = true;
      }
      return holder;
    });
  }

  /** The claim's transaction: who holds it instead, or undefined once these records do. */
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
      // Asked outside the transaction: no process is asked under its lock.
      (seen) =>
        seen === undefined || seen.ownerId === this.#owner
          ? null
          : heldBy(seen),
      (seen, holder) =>
        this.#database.transaction(
          async (transaction): Promise<string | undefined | typeof CHANGED> => {
            if (!sameOwnerColumns(await look(transaction), seen)) {
              return CHANGED;
            }
            if (holder !== null) {
              return sameProcess(holder, thisProcess())
                ? "another engine in this process"
                : `pid ${String(holder.pid)}`;
            }
            const owner = ownedHere(this.#owner);
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

  /** Give up the delivery claim, if these records hold it. */
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
      // Still these records' until a release lands: a retry tries again.
      throw busyError(error) ?? error;
    }
    this.#claimed = false;
  }

  watch(listener: () => void): () => void {
    return this.changes.watch(listener);
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
