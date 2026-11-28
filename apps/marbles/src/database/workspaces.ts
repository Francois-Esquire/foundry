import { and, asc, eq } from "drizzle-orm";
import { marblesWorkspaces } from "~/database/tables";
import type { StoreDatabase } from "~/database/types";
import type { Workspace, WorkspaceRecord } from "~/lib/state/workspace";

export interface TouchOptions {
  readonly cwd?: string;
  readonly hosted?: boolean;
}

export interface WorkspaceRegistryOptions {
  readonly acceptWorkspace?: (id: string) => boolean;
  readonly database: StoreDatabase;
}

export class WorkspaceRegistry {
  readonly #accepts: (id: string) => boolean;
  readonly #database: StoreDatabase;

  constructor(options: WorkspaceRegistryOptions) {
    this.#database = options.database;
    this.#accepts = options.acceptWorkspace ?? (() => true);
  }

  async touch(
    workspace: Workspace,
    config: string | null,
    options: TouchOptions = {}
  ): Promise<void> {
    const now = new Date().toISOString();
    const { hosted } = options;
    const cwd =
      options.cwd === undefined || options.cwd === workspace.root
        ? null
        : options.cwd;
    const registersCwd = options.cwd === undefined ? {} : { cwd };
    await this.#database
      .insert(marblesWorkspaces)
      .values({
        config,
        cwd,
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
          ...registersCwd,
          root: workspace.root,
          ...(hosted === undefined ? {} : { hosted }),
        },
        target: marblesWorkspaces.id,
      });
  }

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

  async read(id: string): Promise<WorkspaceRecord | undefined> {
    const [record] = await this.#database
      .select()
      .from(marblesWorkspaces)
      .where(eq(marblesWorkspaces.id, id));
    return record !== undefined && this.#counts(record)
      ? registered(record)
      : undefined;
  }

  async list(): Promise<readonly WorkspaceRecord[]> {
    const records = await this.#database
      .select()
      .from(marblesWorkspaces)
      .orderBy(asc(marblesWorkspaces.id));
    return records
      .filter((record) => this.#counts(record))
      .map((record) => registered(record));
  }

  #counts(record: Pick<WorkspaceRecord, "id">): boolean {
    return this.#accepts(record.id);
  }
}

function registered(
  row: typeof marblesWorkspaces.$inferSelect
): WorkspaceRecord {
  return { ...row, cwd: row.cwd ?? row.root };
}
