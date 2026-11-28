import type { HostDatabaseOptions, StoreDatabase } from "~/database/open";
import { initializeDatabase, readDatabase, writeAsHost } from "~/database/open";
import { marblesWorkspaces } from "~/database/tables";
import type { TouchOptions } from "~/database/workspaces";
import { WorkspaceRegistry } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import type { Workspace, WorkspaceRecord } from "~/state/workspace";
import { insideState } from "~/state/workspace";

async function asProcess<T>(
  state: string,
  work: (database: StoreDatabase) => Promise<T>
): Promise<T> {
  const opened = await initializeDatabase(stateDatabase(state));
  try {
    return await work(opened.database);
  } finally {
    opened.close();
  }
}

export function seedWorkspace(
  state: string,
  record: typeof marblesWorkspaces.$inferInsert
): Promise<void> {
  return asProcess(state, async (database) => {
    await database.insert(marblesWorkspaces).values(record);
  });
}

export function touchWorkspace(
  state: string,
  workspace: Workspace,
  config: string | null,
  options?: TouchOptions
): Promise<void> {
  return asProcess(state, (database) =>
    new WorkspaceRegistry({
      acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
      database,
    }).touch(workspace, config, options)
  );
}

export function recordWorkspace(
  state: string,
  workspace: Workspace,
  config: string | null,
  options: HostDatabaseOptions = {}
): Promise<void> {
  return writeAsHost(
    state,
    (database) =>
      new WorkspaceRegistry({
        acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
        database,
      }).touch(workspace, config),
    options
  );
}

export function readWorkspace(
  state: string,
  id: string
): Promise<WorkspaceRecord | undefined> {
  return readDatabase(stateDatabase(state), (database) =>
    new WorkspaceRegistry({
      acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
      database,
    }).read(id)
  );
}
