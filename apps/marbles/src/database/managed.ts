import { dirname, resolve } from "node:path";
import type { SessionMessage, SessionRecord } from "@foundry/agents/schema";
import type { SessionStore, SessionStoreWrite } from "@foundry/agents/store";
import { capturedSessionWrite } from "@foundry/agents/store/sqlite";
import type { TaskStore, TaskStoreWrite } from "@foundry/tasks";
import type { MarblesDatabase } from "~/database/open";
import { DatabaseSessionStore } from "~/database/sessions";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import type { HostDatabaseOptions } from "~/database/workspaces";
import { openHostDatabase } from "~/database/workspaces";
import type {
  PendingQuery,
  StreamItem,
  WorkspaceRecords,
} from "~/lib/events/records";
import { EmitListeners, RecordsGate } from "~/lib/events/records";
import type { Workspace } from "~/lib/state/workspace";
import { workspaceState } from "~/lib/state/workspace";
import type { ListedSessionStore, SessionStamp } from "~/lib/usage-evidence";

export interface OpenWorkspaceRecordsOptions extends HostDatabaseOptions {
  /** The Marbles state root, whose `marbles.db` holds the tasks. */
  readonly state: string;
  /** The workspace whose tasks these are: the scope of its rows. */
  readonly workspaceId: string;
}

/**
 * A workspace's tasks and their recorded changes in the Marbles database
 * of the state root `state`, for an engine's `records`: opened on the
 * first call, under the rule a host keeps (`openHostDatabase`: made and
 * migrated only under the state root's lock, otherwise required to be
 * current), and closed with it. The handle these open is theirs: `close`,
 * which the engine calls on dispose, closes it too.
 *
 * An open that fails is tried again by the next call.
 */
export function openWorkspaceRecords(
  options: OpenWorkspaceRecordsOptions
): WorkspaceRecords {
  const database = new LazyDatabase(options);
  return new ManagedWorkspaceRecords(database, options.workspaceId, () =>
    database.close()
  );
}

/**
 * A workspace's tasks and its agent sessions over one handle on the Marbles
 * database, opened at the first call to either as `openWorkspaceRecords`
 * opens its own. Closing `records` leaves the handle open, as an engine
 * closes its records before the agents that may still write a session;
 * `close`, after the engine is disposed, closes both and the handle.
 */
export interface WorkspaceDatabase {
  close(): Promise<void>;
  readonly records: WorkspaceRecords;
  readonly sessions: ListedSessionStore;
}

/** `openWorkspaceRecords`, with the workspace's sessions over the same handle. */
export function openWorkspaceDatabase(
  options: OpenWorkspaceRecordsOptions
): WorkspaceDatabase {
  const database = new LazyDatabase(options);
  const records = new ManagedWorkspaceRecords(
    database,
    options.workspaceId,
    () => Promise.resolve()
  );
  const sessions = new ManagedSessionStore(database, options.workspaceId);
  return {
    async close() {
      try {
        await records.close();
        await sessions.close();
      } finally {
        await database.close();
      }
    },
    records,
    sessions,
  };
}

/**
 * The records an engine given `state` and no `records` keeps its tasks in.
 * When `state` is the directory Marbles itself places the workspace at
 * `root` in, under the state root above it (`<stateRoot>/<id>`, the id
 * derived from `root`, and `workspaceId` that id), they are that state
 * root's, the tasks the CLI and MCP see for that workspace. Otherwise
 * they are those of a database of the engine's own, `<state>/marbles.db`,
 * so nothing is written outside the directory the caller gave.
 */
export function defaultWorkspaceRecords(
  state: string,
  root: string,
  workspaceId: string
): WorkspaceRecords {
  return openWorkspaceRecords({
    state: defaultStateRoot(state, root, workspaceId),
    workspaceId,
  });
}

/**
 * `defaultWorkspaceRecords`, with the workspace's sessions over the same
 * handle (`openWorkspaceDatabase`), for an engine whose sessions are kept
 * in the database too.
 */
export function defaultWorkspaceDatabase(
  state: string,
  root: string,
  workspaceId: string
): WorkspaceDatabase {
  return openWorkspaceDatabase({
    state: defaultStateRoot(state, root, workspaceId),
    workspaceId,
  });
}

/** The state root whose database an engine given `state` keeps its records in (`defaultWorkspaceRecords`). */
function defaultStateRoot(
  state: string,
  root: string,
  workspaceId: string
): string {
  const dir = resolve(state);
  return placedByMarbles(dir, root, workspaceId) ? dirname(dir) : dir;
}

function placedByMarbles(
  dir: string,
  root: string,
  workspaceId: string
): boolean {
  let placed: Workspace;
  try {
    placed = workspaceState(dirname(dir), root);
  } catch {
    // A root that cannot be resolved is no workspace Marbles placed.
    return false;
  }
  return placed.id === workspaceId && placed.dir === dir;
}

/**
 * One writer handle on a state root's database, opened at the first call
 * under the rule a host keeps (`openHostDatabase`). An open that fails is
 * tried again by the next call.
 */
class LazyDatabase {
  readonly #options: OpenWorkspaceRecordsOptions;
  #opening: Promise<MarblesDatabase> | undefined;

  constructor(options: OpenWorkspaceRecordsOptions) {
    this.#options = options;
  }

  open(): Promise<MarblesDatabase> {
    const { state, workspaceId: _, ...options } = this.#options;
    this.#opening ??= openHostDatabase(state, options).catch(
      (error: unknown) => {
        this.#opening = undefined;
        throw error;
      }
    );
    return this.#opening;
  }

  /** Close the handle, if one was opened; a later `open` opens another. */
  async close(): Promise<void> {
    const opening = this.#opening;
    this.#opening = undefined;
    (await opening?.catch(() => undefined))?.close();
  }
}

/**
 * The value `make` builds over the database the first time it is asked
 * for, once the database is open; built again if that open failed.
 */
class OverDatabase<T> {
  readonly #database: LazyDatabase;
  readonly #make: (database: MarblesDatabase) => T;
  #built: Promise<T> | undefined;

  constructor(database: LazyDatabase, make: (database: MarblesDatabase) => T) {
    this.#database = database;
    this.#make = make;
  }

  get(): Promise<T> {
    this.#built ??= this.#database
      .open()
      .then(this.#make)
      .catch((error: unknown) => {
        this.#built = undefined;
        throw error;
      });
    return this.#built;
  }

  /** What was built, if anything was; nothing is built after this. */
  async built(): Promise<T | undefined> {
    const built = this.#built;
    this.#built = undefined;
    return await built?.catch(() => undefined);
  }
}

class ManagedWorkspaceRecords implements WorkspaceRecords {
  readonly taskStore: TaskStore;
  readonly #gate = new RecordsGate();
  readonly #listeners = new EmitListeners();
  readonly #records: OverDatabase<DatabaseWorkspaceRecords>;
  readonly #release: () => Promise<void>;

  constructor(
    database: LazyDatabase,
    workspaceId: string,
    release: () => Promise<void>
  ) {
    this.#release = release;
    this.#records = new OverDatabase(database, (opened) => {
      const records = new DatabaseWorkspaceRecords({
        database: opened.database,
        scope: workspaceId,
      });
      records.watch(() => this.#listeners.emit());
      return records;
    });
    const store = async () => (await this.#records.get()).taskStore;
    this.taskStore = {
      commit: (write) => {
        // The write as it stands now: the database may still be opening.
        let owned: TaskStoreWrite;
        try {
          owned = structuredClone(write);
        } catch (error) {
          return Promise.reject(error);
        }
        return this.#gate.run(async () => (await store()).commit(owned));
      },
      get: (id) => this.#gate.run(async () => (await store()).get(id)),
      snapshot: () => this.#gate.run(async () => (await store()).snapshot()),
      transaction: (work) =>
        this.#gate.run(async () => {
          const inner = await store();
          return inner.transaction === undefined
            ? work(inner)
            : inner.transaction(work);
        }),
    };
  }

  async close(): Promise<void> {
    await this.#gate.close();
    try {
      await (await this.#records.built())?.close();
    } finally {
      await this.#release();
    }
  }

  deliver(id: string, hash: string): Promise<void> {
    return this.#gate.run(async () =>
      (await this.#records.get()).deliver(id, hash)
    );
  }

  latest(): Promise<number> {
    return this.#gate.run(async () => (await this.#records.get()).latest());
  }

  pending(query: PendingQuery): Promise<readonly StreamItem[]> {
    return this.#gate.run(async () =>
      (await this.#records.get()).pending(query)
    );
  }

  watch(listener: () => void): () => void {
    return this.#listeners.add(listener);
  }
}

/**
 * A workspace's sessions over a `LazyDatabase`: each call waits for the
 * database to open, and `close` refuses later calls once those made have
 * settled. A commit owns its write from the call, before the open.
 */
class ManagedSessionStore implements ListedSessionStore {
  readonly #gate = new RecordsGate();
  readonly #store: OverDatabase<DatabaseSessionStore>;

  constructor(database: LazyDatabase, workspaceId: string) {
    this.#store = new OverDatabase(
      database,
      (opened) =>
        new DatabaseSessionStore({
          database: opened.database,
          scope: workspaceId,
        })
    );
  }

  close(): Promise<void> {
    return this.#gate.close();
  }

  commit(write: SessionStoreWrite): Promise<void> {
    // The write as it stands now, as the package store takes it, refused as
    // it refuses it: the database may still be opening.
    let owned: SessionStoreWrite;
    try {
      owned = capturedSessionWrite(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#run((store) => store.commit(owned));
  }

  getMessage(id: string): Promise<SessionMessage | null> {
    return this.#run((store) => store.getMessage(id));
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return this.#run((store) => store.getSession(id));
  }

  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.#run((store) => store.listMessages(sessionId));
  }

  stamps(): Promise<readonly SessionStamp[]> {
    return this.#run((store) => store.stamps());
  }

  transaction<T>(work: (view: SessionStore) => Promise<T>): Promise<T> {
    return this.#run((store) => store.transaction(work));
  }

  #run<T>(call: (store: DatabaseSessionStore) => Promise<T>): Promise<T> {
    return this.#gate.run(async () => call(await this.#store.get()));
  }
}
