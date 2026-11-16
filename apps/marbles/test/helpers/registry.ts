import type { StoreDatabase } from "~/database/open";
import { initializeDatabase, readDatabase } from "~/database/open";
import { marblesWorkspaces } from "~/database/tables";
import type { HostDatabaseOptions, TouchOptions } from "~/database/workspaces";
import { WorkspaceRegistry, writeAsHost } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import type { Workspace, WorkspaceRecord } from "~/lib/state/workspace";

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
  record: WorkspaceRecord
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
    new WorkspaceRegistry({ database, state }).touch(workspace, config, options)
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
      new WorkspaceRegistry({ database, state }).touch(workspace, config),
    options
  );
}

export function readWorkspace(
  state: string,
  id: string
): Promise<WorkspaceRecord | undefined> {
  return readDatabase(stateDatabase(state), (database) =>
    new WorkspaceRegistry({ database, state }).read(id)
  );
}
