import { directory } from "../../directory";
import type { WorkspaceFileSystem } from "../../filesystem";
import type { WorkspaceStore } from "../../workspace-store";
import { WorkspaceSystem } from "../../workspace-system";

/** A system with the directory layer registered. */
export function directorySystem(
  options: { store?: WorkspaceStore; filesystem?: WorkspaceFileSystem } = {}
) {
  return new WorkspaceSystem(
    options.store ? { store: options.store } : {}
  ).extend(
    directory(options.filesystem ? { filesystem: options.filesystem } : {})
  );
}
