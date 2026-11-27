import { join, resolve } from "node:path";
import { holdsLock } from "@foundry/lib/node/file-lock";

import { and, asc, eq } from "drizzle-orm";
import { IncompatibleDatabaseError } from "~/database/migrate-core";
import type {
  MarblesDatabase,
  OpenDatabaseOptions,
  StoreDatabase,
} from "~/database/open";
import {
  initializeDatabase,
  openDatabase,
  readDatabase,
} from "~/database/open";
import { marblesWorkspaces } from "~/database/tables";
import { stateDatabase } from "~/layout";
import { acquireLock, PROCESS_LOCK } from "~/lib/state/locks";
import type { Workspace, WorkspaceRecord } from "~/lib/state/workspace";
import { insideState } from "~/lib/state/workspace";

export interface TouchOptions {
  readonly cwd?: string;
  readonly hosted?: boolean;
}

export interface WorkspaceRegistryOptions {
  readonly acceptWorkspace?: (id: string) => boolean;
  readonly database: StoreDatabase;
  readonly state?: string;
}

export class WorkspaceRegistry {
  readonly #accepts: (id: string) => boolean;
  readonly #database: StoreDatabase;

  constructor(options: WorkspaceRegistryOptions) {
    this.#database = options.database;
    this.#accepts = workspaceAcceptance(options);
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

export function workspaceAcceptance(options: {
  readonly acceptWorkspace?: (id: string) => boolean;
  readonly state?: string;
}): (id: string) => boolean {
  const { acceptWorkspace, state } = options;
  if (acceptWorkspace !== undefined) {
    return acceptWorkspace;
  }
  if (state === undefined) {
    return () => true;
  }
  const root = resolve(state);
  return (id) => insideState(root, id);
}

function registered(
  row: typeof marblesWorkspaces.$inferSelect
): WorkspaceRecord {
  return { ...row, cwd: row.cwd ?? row.root };
}

export async function recordedWorkspaces(
  state: string
): Promise<readonly WorkspaceRecord[]> {
  const records = await readDatabase(stateDatabase(state), (database) =>
    new WorkspaceRegistry({ database, state }).list()
  );
  return records ?? [];
}

export interface HostDatabaseOptions extends OpenDatabaseOptions {
  readonly wait?: number;
}

const HOST_WAIT_MS = 5000;
const HOST_RETRY_MS = 50;

export async function openHostDatabase(
  state: string,
  options: HostDatabaseOptions = {}
): Promise<MarblesDatabase> {
  const root = resolve(state);
  const file = stateDatabase(root);
  const deadline = Date.now() + (options.wait ?? HOST_WAIT_MS);
  for (;;) {
    const claim = acquireLock(root, PROCESS_LOCK);
    if ("release" in claim) {
      try {
        return await initializeDatabase(file, options);
      } finally {
        claim.release();
      }
    }
    if (holdsLock(join(root, "locks", PROCESS_LOCK))) {
      return await initializeDatabase(file, options);
    }
    let opened: MarblesDatabase | undefined;
    try {
      opened = await openDatabase(file, options);
    } catch (error) {
      if (!(error instanceof IncompatibleDatabaseError)) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw error;
      }
    }
    if (opened !== undefined) {
      return opened;
    }
    if (Date.now() >= deadline) {
      throw new IncompatibleDatabaseError(
        `there is no Marbles database at ${file} yet, and ${claim.holder} holds the state root, so this host does not make one; start the Marbles process, or retry once it is up`
      );
    }
    await new Promise((settle) => setTimeout(settle, HOST_RETRY_MS));
  }
}

export async function writeAsHost<T>(
  state: string,
  work: (database: StoreDatabase) => Promise<T>,
  options: HostDatabaseOptions = {}
): Promise<T> {
  const opened = await openHostDatabase(state, options);
  try {
    return await work(opened.database);
  } finally {
    opened.close();
  }
}
