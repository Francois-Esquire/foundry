import type { WorkspaceFileSystem } from "../../filesystem";
import { directory } from "../../node";
import type { WorkspaceStore } from "../../workspace-store";
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
