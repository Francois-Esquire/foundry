import { resolve } from "node:path";

import { and, asc, eq } from "drizzle-orm";
import { IncompatibleDatabaseError } from "~/database/migrate";
import type { OpenDatabaseOptions, StoreDatabase } from "~/database/open";
import {
  initializeDatabase,
  readDatabase,
  writeDatabase,
} from "~/database/open";
import { marblesWorkspaces } from "~/database/tables";
import { stateDatabase } from "~/layout";
import { acquireLock, PROCESS_LOCK } from "~/lib/state/locks";
import type { Workspace, WorkspaceRecord } from "~/lib/state/workspace";
import { insideState } from "~/lib/state/workspace";

export interface TouchOptions {
  /** Whether the Marbles process hosts this workspace; kept as it was when omitted. */
  readonly hosted?: boolean;
}

export interface WorkspaceRegistryOptions {
  readonly database: StoreDatabase;
  /** The state root the records' directories are under. */
  readonly state: string;
}

/**
 * Every workspace this machine has run, in the Marbles database: the
 * registry of the ids every package's rows are scoped by.
 *
 * A record counts only while `<state>/<id>` keeps what is written there
 * inside the state root (`insideState`): a link there names nothing, so
 * whatever lists, looks up, or restores workspaces through the registry
 * leaves it out, and none of them can disagree on which.
 */
export class WorkspaceRegistry {
  readonly #database: StoreDatabase;
  readonly #state: string;

  constructor(options: WorkspaceRegistryOptions) {
    this.#database = options.database;
    this.#state = resolve(options.state);
  }

  /**
   * Record a sight of `workspace`, run from `config`: the first sets
   * `firstSeen`, every one sets `lastSeen`. One statement, so two
   * processes touching the same workspace never lose either's write.
   */
  async touch(
    workspace: Workspace,
    config: string | null,
    options: TouchOptions = {}
  ): Promise<void> {
    const now = new Date().toISOString();
    const { hosted } = options;
    await this.#database
      .insert(marblesWorkspaces)
      .values({
        config,
        firstSeen: now,
        hosted: hosted ?? false,
        id: workspace.id,
        lastSeen: now,
        root: workspace.root,
      })
      .onConflictDoUpdate({
        set: {
          config,
          lastSeen: now,
          root: workspace.root,
          ...(hosted === undefined ? {} : { hosted }),
        },
        target: marblesWorkspaces.id,
      });
  }

  /**
   * Record `id` as not hosted, whatever its directory is: by id alone, so
   * nothing under the state root is looked at or followed. A linked
   * workspace is left out of every read, but its record must still be
   * cleared, or it is hosted again at boot once the link is gone. Whether
   * a hosted record was there to clear.
   */
  async unhost(id: string): Promise<boolean> {
    const cleared = await this.#database
      .update(marblesWorkspaces)
      .set({ hosted: false })
      .where(
        and(eq(marblesWorkspaces.id, id), eq(marblesWorkspaces.hosted, true))
      )
      .returning({ id: marblesWorkspaces.id });
    return cleared.length > 0;
  }

  /** The record of `id`; undefined when none was made, or its directory is a link. */
  async read(id: string): Promise<WorkspaceRecord | undefined> {
    const [record] = await this.#database
      .select()
      .from(marblesWorkspaces)
      .where(eq(marblesWorkspaces.id, id));
    return record !== undefined && this.#counts(record) ? record : undefined;
  }

  /** Every record, by id, but those whose directory is a link. */
  async list(): Promise<readonly WorkspaceRecord[]> {
    const records = await this.#database
      .select()
      .from(marblesWorkspaces)
      .orderBy(asc(marblesWorkspaces.id));
    return records.filter((record) => this.#counts(record));
  }

  #counts(record: WorkspaceRecord): boolean {
    return insideState(this.#state, record.id);
  }
}

/**
 * Every workspace recorded under the state root (`WorkspaceRegistry.list`).
 * Read only: a state root without a database has none and is left
 * without one.
 */
export async function recordedWorkspaces(
  state: string
): Promise<readonly WorkspaceRecord[]> {
  const records = await readDatabase(stateDatabase(state), (database) =>
    new WorkspaceRegistry({ database, state }).list()
  );
  return records ?? [];
}

export interface RecordWorkspaceOptions extends OpenDatabaseOptions {
  /**
   * How long to wait, while another process holds the state root, for the
   * database to be current; 5 s when omitted.
   */
  readonly wait?: number;
}

const RECORD_WAIT_MS = 5000;
const RECORD_RETRY_MS = 50;

/**
 * Record a sight of `workspace` for a program that hosts it: a worker of
 * the Marbles process, or a program hosting it itself. Such a host is a
 * writer, and may make and migrate the database, but only while it holds
 * the state root's process lock, the one the Marbles process claims for its
 * lifetime (`PROCESS_LOCK`). It takes it atomically, makes or migrates the
 * database and records the workspace under it, and lets it go: held only
 * that long, so a Marbles process can start beside a host that runs for
 * hours, as it always could, while no two processes ever migrate at once.
 *
 * When another process holds the lock (the Marbles process, or a host
 * doing the same), this one never migrates: it records the workspace in a
 * database that is current, waiting up to `wait` for the holder to make it
 * so, and otherwise throws `IncompatibleDatabaseError`.
 */
export async function recordWorkspace(
  state: string,
  workspace: Workspace,
  config: string | null,
  options: RecordWorkspaceOptions = {}
): Promise<void> {
  const root = resolve(state);
  const file = stateDatabase(root);
  const touch = (database: StoreDatabase) =>
    new WorkspaceRegistry({ database, state: root }).touch(workspace, config);
  const deadline = Date.now() + (options.wait ?? RECORD_WAIT_MS);
  for (;;) {
    const claim = acquireLock(root, PROCESS_LOCK);
    if ("release" in claim) {
      try {
        const opened = await initializeDatabase(file, options);
        try {
          await touch(opened.database);
        } finally {
          opened.close();
        }
      } finally {
        claim.release();
      }
      return;
    }
    let recorded = false;
    try {
      recorded =
        (await writeDatabase(
          file,
          async (database) => {
            await touch(database);
            return true;
          },
          options
        )) === true;
    } catch (error) {
      if (!(error instanceof IncompatibleDatabaseError)) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw error;
      }
    }
    if (recorded) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new IncompatibleDatabaseError(
        `there is no Marbles database at ${file} yet, and ${claim.holder} holds the state root, so this host does not make one; start the Marbles process, or retry once it is up`
      );
    }
    await new Promise((settle) => setTimeout(settle, RECORD_RETRY_MS));
  }
}
