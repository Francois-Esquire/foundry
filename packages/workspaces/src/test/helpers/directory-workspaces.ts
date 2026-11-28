import type { WorkspaceFileSystem } from "../../file-system";
import { directory } from "../../node";
import type { WorkspaceStore } from "../../store";

import { Workspaces } from "../../workspaces";

export function directoryWorkspaces(
  options: { store?: WorkspaceStore; filesystem?: WorkspaceFileSystem } = {}
) {
  return new Workspaces(options.store ? { store: options.store } : {}).extend(
    directory(options.filesystem ? { filesystem: options.filesystem } : {})
  );
}
