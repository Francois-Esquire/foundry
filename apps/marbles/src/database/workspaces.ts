import { resolve } from "node:path";

import { and, asc, eq } from "drizzle-orm";

import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import { marblesWorkspaces } from "~/database/tables";
import { stateDatabase } from "~/layout";
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
