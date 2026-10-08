import { readdir, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { ModuleSourceFileSystem } from "../source";

import { captureModuleWorkspaceSource as captureSource } from "../source";

const nodeSourceFileSystem: ModuleSourceFileSystem = {
  async readDirectory(path) {
    return (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      type: entryType(entry),
    }));
  },
  readFile,
  separator: sep,
};

function entryType(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): "symlink" | "file" | "directory" | "unknown" {
  if (entry.isSymbolicLink()) {
    return "symlink";
  }
  if (entry.isFile()) {
    return "file";
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  return "unknown";
}

export function captureModuleWorkspaceSource(
  root: string
): Promise<Readonly<Record<string, string>>> {
  return captureSource(nodeSourceFileSystem, resolve(root));
}
