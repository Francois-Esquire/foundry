import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
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
import type { EntryStats, Storage } from "@foundry/core/storage";
import type { DirectoryOptions as PortableDirectoryOptions } from "../directory";
import {
  directory as storageDirectory,
  WithDirectory as WithStorageDirectory,
} from "../directory";
import type { WorkspaceCtor } from "../types";

export type DirectoryOptions = Partial<PortableDirectoryOptions>;

export function directory(options: DirectoryOptions = {}) {
  return storageDirectory({
    ...options,
    filesystem: options.filesystem ?? nodeFileSystem,
  });
}

export function WithDirectory<B extends WorkspaceCtor>(
  Base: B,
  options: DirectoryOptions = {}
) {
  return WithStorageDirectory(Base, {
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

export const nodeFileSystem: Storage = {
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
  /**
   * Bounded atomic replacement: an exclusive sibling temporary file receives
   * the exact bytes and the existing file's permission bits, is synced and
   * closed, then renamed over the original within the same directory. Failure
   * before the rename leaves the original untouched and best-effort unlinks
   * the temp. Compare-then-rename is optimistic concurrency — an
   * external write inside that interval wins the rename, not a lock — and the
   * rename's durability is the host filesystem's contract; neither
   * snapshot isolation nor a directory fsync is claimed here.
   */
  async replaceFile(path, bytes) {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new Error(`Cannot replace a non-regular file: ${path}`);
    }
    // biome-ignore lint/suspicious/noBitwiseOperators: Filesystem permissions are a bit mask.
    const mode = stats.mode & 0o7777;
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temp, mode);
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

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
