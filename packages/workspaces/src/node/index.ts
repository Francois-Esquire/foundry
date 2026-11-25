import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import type {
  EntryStats,
  Storage,
  StorageFileCreator,
} from "@foundry/core/storage";
import type { DirectoryOptions as PortableDirectoryOptions } from "../directory";
import {
  directory as storageDirectory,
  directorySource as storageDirectorySource,
} from "../directory";
import type { WorkspaceSourceAdapter } from "../types";
import type { WorkspacesOptions } from "../workspaces";
import { Workspaces } from "../workspaces";
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

function entryStats(stats: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isSocket(): boolean;
  isFIFO(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
}): EntryStats {
  if (stats.isSymbolicLink()) {
    return { type: "symlink" };
  }
  if (stats.isFile()) {
    return { type: "file" };
  }
  if (stats.isDirectory()) {
    return { type: "directory" };
  }
  if (stats.isSocket()) {
    return { type: "socket" };
  }
  if (stats.isFIFO()) {
    return { type: "pipe" };
  }
  if (stats.isBlockDevice() || stats.isCharacterDevice()) {
    return { type: "device" };
  }
  return { type: "unknown" };
}

async function writeSibling(
  path: string,
  bytes: Uint8Array,
  mode?: number
): Promise<string> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      if (mode !== undefined) {
        await handle.chmod(mode);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return temp;
}

export const nodeFileSystem: Storage & StorageFileCreator = {
  async createFile(path, bytes) {
    const temp = await writeSibling(path, bytes);
    try {
      await link(temp, path);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  },
  async lstat(path) {
    const stats = await lstat(path);
    return entryStats(stats);
  },
  async readDirectory(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      ...entryStats(entry),
      name: entry.name,
    }));
  },
  async readFile(path) {
    return new Uint8Array(await readFile(path));
  },
  readLink: (path) => readlink(path),
  realpath: (path) => realpath(path),
  async replaceFile(path, bytes) {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new Error(`Cannot replace a non-regular file: ${path}`);
    }
    // biome-ignore lint/suspicious/noBitwiseOperators: Filesystem permissions are a bit mask.
    const mode = stats.mode & 0o7777;
    const temp = await writeSibling(path, bytes, mode);
    try {
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  },
  separator: sep,
  async writeFile(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  },
};
