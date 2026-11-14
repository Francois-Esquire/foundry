import { resolve } from "node:path";

import { asc, eq } from "drizzle-orm";

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

/**
 * Every workspace this machine has run, in the Marbles database: the
 * registry of the ids every package's rows are scoped by.
 */
export class WorkspaceRegistry {
  readonly #database: StoreDatabase;

  constructor(options: { readonly database: StoreDatabase }) {
    this.#database = options.database;
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

  /** The record of `id`, or undefined when none was ever made. */
  async read(id: string): Promise<WorkspaceRecord | undefined> {
    const [record] = await this.#database
      .select()
      .from(marblesWorkspaces)
      .where(eq(marblesWorkspaces.id, id));
    return record;
  }

  /** Every record, by id. */
  list(): Promise<readonly WorkspaceRecord[]> {
    return this.#database
      .select()
      .from(marblesWorkspaces)
      .orderBy(asc(marblesWorkspaces.id));
  }
}

/**
 * Every workspace recorded under the state root, by id, leaving out any
 * whose `<state>/<id>` is a link. Read only: a state root without a
 * database has none and is left without one.
 */
export async function recordedWorkspaces(
  state: string
): Promise<readonly WorkspaceRecord[]> {
  const root = resolve(state);
  const records = await readDatabase(stateDatabase(root), (database) =>
    new WorkspaceRegistry({ database }).list()
  );
  return (records ?? []).filter((record) => insideState(root, record.id));
}
