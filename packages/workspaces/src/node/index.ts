import type { DirectoryOptions as PortableDirectoryOptions } from "../directory";
import {
  directory as storageDirectory,
  directorySource as storageDirectorySource,
} from "../directory";
import type { WorkspaceSourceAdapter } from "../source-adapter";
import type { WorkspacesOptions } from "../workspaces";
import { Workspaces } from "../workspaces";
import { nodeFileSystem } from "./file-system";
import { nodeObserver } from "./watch";

export type DirectoryOptions = Partial<PortableDirectoryOptions>;

export function workspaces(options?: WorkspacesOptions) {
  return new Workspaces(options).extend(directory({ observer: nodeObserver }));
}

export function directory(options: DirectoryOptions = {}) {
  return storageDirectory({
    ...options,
    filesystem: options.filesystem ?? nodeFileSystem,
  });
}

export function directorySource(
  root: string,
  options: DirectoryOptions = {}
): WorkspaceSourceAdapter {
  return storageDirectorySource(root, {
    ...options,
    filesystem: options.filesystem ?? nodeFileSystem,
  });
}

// biome-ignore lint/performance/noBarrelFile: This is a declared package entry point; preserve its public exports.
export { nodeFileSystem } from "./file-system";
