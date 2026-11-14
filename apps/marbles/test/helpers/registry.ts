import type { StoreDatabase } from "~/database/open";
import { initializeDatabase, readDatabase } from "~/database/open";
import { marblesWorkspaces } from "~/database/tables";
import type { TouchOptions } from "~/database/workspaces";
import { WorkspaceRegistry } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import type { Workspace, WorkspaceRecord } from "~/lib/state/workspace";

/** Open the database under `state` as the Marbles process would, for `work`. */
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

/** Store `record` as it is, times included, in the database under `state`. */
export function seedWorkspace(
  state: string,
  record: WorkspaceRecord
): Promise<void> {
  return asProcess(state, async (database) => {
    await database.insert(marblesWorkspaces).values(record);
  });
}

/** Record a sight of `workspace` under `state`, as the Marbles process does. */
export function touchWorkspace(
  state: string,
  workspace: Workspace,
  config: string | null,
  options?: TouchOptions
): Promise<void> {
  return asProcess(state, (database) =>
    new WorkspaceRegistry({ database }).touch(workspace, config, options)
  );
}

/** What the registry under `state` holds for `id`, read as `status` reads it. */
export function readWorkspace(
  state: string,
  id: string
): Promise<WorkspaceRecord | undefined> {
  return readDatabase(stateDatabase(state), (database) =>
    new WorkspaceRegistry({ database }).read(id)
  );
}
