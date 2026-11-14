import { withDatabase } from "~/database/open";
import { marblesWorkspaces } from "~/database/tables";
import type { TouchOptions } from "~/database/workspaces";
import { WorkspaceRegistry } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import type { Workspace, WorkspaceRecord } from "~/lib/state/workspace";

/** Store `record` as it is, times included, in the database under `state`. */
export function seedWorkspace(
  state: string,
  record: WorkspaceRecord
): Promise<void> {
  return withDatabase(stateDatabase(state), async (database) => {
    await database.insert(marblesWorkspaces).values(record);
  });
}

/** Record a sight of `workspace` under `state`, as a host does. */
export function touchWorkspace(
  state: string,
  workspace: Workspace,
  config: string | null,
  options?: TouchOptions
): Promise<void> {
  return withDatabase(stateDatabase(state), (database) =>
    new WorkspaceRegistry({ database }).touch(workspace, config, options)
  );
}

/** What the registry under `state` holds for `id`. */
export function readWorkspace(
  state: string,
  id: string
): Promise<WorkspaceRecord | undefined> {
  return withDatabase(stateDatabase(state), (database) =>
    new WorkspaceRegistry({ database }).read(id)
  );
}
