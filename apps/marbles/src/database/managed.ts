import { dirname, resolve } from "node:path";
import type { TaskStore, TaskStoreWrite } from "@foundry/tasks";
import type { MarblesDatabase } from "~/database/open";
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

export interface OpenWorkspaceRecordsOptions extends HostDatabaseOptions {
  /** The Marbles state root, whose `marbles.db` holds the tasks. */
  readonly state: string;
  /** The workspace whose tasks these are: the scope of its rows. */
  readonly workspaceId: string;
}

interface Opened {
  readonly database: MarblesDatabase;
  readonly records: DatabaseWorkspaceRecords;
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
  return new ManagedWorkspaceRecords(options);
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
  const dir = resolve(state);
  return openWorkspaceRecords({
    state: placedByMarbles(dir, root, workspaceId) ? dirname(dir) : dir,
    workspaceId,
  });
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

class ManagedWorkspaceRecords implements WorkspaceRecords {
  readonly taskStore: TaskStore;
  readonly #options: OpenWorkspaceRecordsOptions;
  readonly #gate = new RecordsGate();
  readonly #listeners = new EmitListeners();
  #opening: Promise<Opened> | undefined;

  constructor(options: OpenWorkspaceRecordsOptions) {
    this.#options = options;
    const store = async () => (await this.#records()).taskStore;
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
    const opening = this.#opening;
    this.#opening = undefined;
    const opened = await opening?.catch(() => undefined);
    if (opened !== undefined) {
      try {
        await opened.records.close();
      } finally {
        opened.database.close();
      }
    }
  }

  deliver(id: string, hash: string): Promise<void> {
    return this.#gate.run(async () =>
      (await this.#records()).deliver(id, hash)
    );
  }

  latest(): Promise<number> {
    return this.#gate.run(async () => (await this.#records()).latest());
  }

  pending(query: PendingQuery): Promise<readonly StreamItem[]> {
    return this.#gate.run(async () => (await this.#records()).pending(query));
  }

  watch(listener: () => void): () => void {
    return this.#listeners.add(listener);
  }

  async #records(): Promise<DatabaseWorkspaceRecords> {
    this.#opening ??= this.#open().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return (await this.#opening).records;
  }

  async #open(): Promise<Opened> {
    const { state, workspaceId, ...options } = this.#options;
    const database = await openHostDatabase(state, options);
    const records = new DatabaseWorkspaceRecords({
      database: database.database,
      scope: workspaceId,
    });
    records.watch(() => this.#listeners.emit());
    return { database, records };
  }
}
