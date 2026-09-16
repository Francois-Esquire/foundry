import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

/** One directory entry, classified without following any symlink. */
export interface DirectoryEntry {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly name: string;
}

export interface EntryStats {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

/**
 * The narrowest filesystem surface the scanner needs.
 *
 * It exists so a test can fail one call after earlier entries were already
 * observed — the condition that proves reconciliation aborts instead of
 * committing a partial inventory.
 */
export interface WorkspaceFileSystem {
  /** Does not follow a symlink at `path`. */
  lstat: (path: string) => Promise<EntryStats>;
  readDirectory: (path: string) => Promise<readonly DirectoryEntry[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  realpath: (path: string) => Promise<string>;
  /**
   * Replaces the regular file at `path` with exactly `bytes`. A throw
   * guarantees the original bytes are unchanged; there is no partial write.
   */
  replaceFile: (path: string, bytes: Uint8Array) => Promise<void>;
}

export const nodeFileSystem: WorkspaceFileSystem = {
  async lstat(path) {
    const stats = await lstat(path);
    return {
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      isSymbolicLink: stats.isSymbolicLink(),
    };
  },
  async readDirectory(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
      name: entry.name,
    }));
  },
  async readFile(path) {
    return new Uint8Array(await readFile(path));
  },
  realpath: (path) => realpath(path),
  /**
   * Bounded atomic replacement: an exclusive sibling temporary file receives
   * the exact bytes and the existing file's permission bits, is synced and
   * closed, then renamed over the original within the same directory. Failure
   * before the rename leaves the original untouched and best-effort unlinks
   * the temp. Compare-then-rename is optimistic concurrency (G-04) — an
   * external write inside that interval wins the rename, not a lock — and the
   * rename's durability is the host filesystem's contract (G-05); neither
   * snapshot isolation nor a directory fsync is claimed here.
   */
  async replaceFile(path, bytes) {
    // biome-ignore lint/suspicious/noBitwiseOperators: Filesystem permissions are a bit mask.
    const mode = (await stat(path)).mode & 0o7777;
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
};

export function joinPath(base: string, segment: string): string {
  return join(base, segment);
}

/** True when `candidate` is the root itself or genuinely inside it. */
export function isBeneath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
