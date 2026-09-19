import { directory } from "../../node";
import type { WorkspaceFileSystem, WorkspaceStore } from "../../types";

import { WorkspaceSystem } from "../../workspace-system";

export function directorySystem(
  options: { store?: WorkspaceStore; filesystem?: WorkspaceFileSystem } = {}
) {
  return new WorkspaceSystem(
    options.store ? { store: options.store } : {}
  ).extend(
    directory(options.filesystem ? { filesystem: options.filesystem } : {})
  );
}
