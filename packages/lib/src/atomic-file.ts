/**
 * Whole-file writes that a concurrent reader never sees half done, and the
 * reads that pair with them.
 *
 * Node-bound: import it from main-process code only.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** True when `error` is a Node system error carrying this `code` (ENOENT, EEXIST, ...). */
export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** True when `error` says a path, or a directory on it, does not exist (ENOENT or ENOTDIR). */
export function isMissingPath(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");
}

export interface AtomicWriteOptions {
  /** Create missing parent directories first. Implied by `directoryMode`. */
  readonly createDirectory?: boolean;
  /** Mode for parent directories this call creates; existing ones keep theirs. */
  readonly directoryMode?: number;
  /**
   * Flush the bytes to disk before the rename, so a crash cannot leave an
   * empty file in place, and flush the directory after it, so the rename
   * itself survives one.
   */
  readonly fsync?: boolean;
  /**
   * The file's mode, exactly: the temporary is created with it and then set
   * through its handle, so the umask cannot narrow it. Defaults to 0o666 less
   * the umask, like `writeFile`.
   */
  readonly mode?: number;
}

/** What `writeFile` creates a file with before the umask applies. */
const DEFAULT_FILE_MODE = 0o666;

/** A fresh name beside `path` for the temporary a write renames over it. */
function temporaryBeside(path: string): string {
  return `${path}.${randomUUID()}.tmp`;
}

/**
 * Write `contents` to a fresh temporary beside `path`, then rename it over
 * `path`. The temporary is created exclusively and removed if any step fails,
 * so a failed write leaves the previous file untouched and nothing behind.
 */
export async function writeFileAtomic(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const {
    createDirectory = false,
    directoryMode,
    fsync = false,
    mode,
  } = options;
  if (createDirectory || directoryMode !== undefined) {
    await mkdir(dirname(path), {
      recursive: true,
      ...(directoryMode === undefined ? {} : { mode: directoryMode }),
    });
  }
  const temporary = temporaryBeside(path);
  try {
    if (fsync || mode !== undefined) {
      // Created with the requested mode, so the bytes are never readable more
      // widely than asked; then set exactly through the handle, since the
      // umask may have narrowed the creation mode. Set after the write, which
      // clears the set-user-ID and set-group-ID bits.
      const file = await open(temporary, "wx", mode ?? DEFAULT_FILE_MODE);
      try {
        await file.writeFile(contents);
        if (mode !== undefined) {
          await file.chmod(mode);
        }
        if (fsync) {
          await file.sync();
        }
      } finally {
        await file.close();
      }
    } else {
      await writeFile(temporary, contents, { flag: "wx" });
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  if (fsync) {
    await syncDirectory(dirname(path));
  }
}

export interface AtomicWriteSyncOptions {
  /** Create missing parent directories first. */
  readonly createDirectory?: boolean;
  /** Flush the bytes before the rename and the directory after it, as `writeFileAtomic` does. */
  readonly fsync?: boolean;
  /** The file's mode, exactly: the temporary is created with it and then set through its descriptor, so the umask cannot narrow it. */
  readonly mode?: number;
}

/**
 * `writeFileAtomic` for synchronous callers. It supports `createDirectory`,
 * `fsync`, and `mode`, but no `directoryMode`. The temporary is created
 * exclusively beside `path`, renamed over it, and removed if any step fails.
 */
export function writeFileAtomicSync(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteSyncOptions = {}
): void {
  if (options.createDirectory) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const temporary = temporaryBeside(path);
  try {
    // Created with the requested mode, so the bytes are never readable more
    // widely than asked; then set exactly through the descriptor, since the
    // umask may have narrowed the creation mode. Set again after the write,
    // which clears the set-user-ID and set-group-ID bits.
    const descriptor = openSync(
      temporary,
      "wx",
      options.mode ?? DEFAULT_FILE_MODE
    );
    try {
      if (options.mode !== undefined) {
        fchmodSync(descriptor, options.mode);
      }
      writeFileSync(descriptor, contents);
      if (options.mode !== undefined) {
        fchmodSync(descriptor, options.mode);
      }
      if (options.fsync) {
        fsyncSync(descriptor);
      }
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  if (options.fsync) {
    syncDirectorySync(dirname(path));
  }
}

function syncFileSync(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Platforms and filesystems that cannot open or flush a directory (Windows,
 * some network and FUSE mounts, a directory without read permission) say so
 * with these. They are swallowed: the rename has already landed, so the
 * write succeeded and only its durability across a crash is weaker. Any other
 * error is reported, though the file has by then been replaced.
 */
const UNSYNCABLE_DIRECTORY = ["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"];

/** Flushes a directory's entries to disk, so a rename or a new entry in it survives a crash; see `UNSYNCABLE_DIRECTORY`. */
export function syncDirectorySync(path: string): void {
  try {
    syncFileSync(path);
  } catch (error) {
    if (!UNSYNCABLE_DIRECTORY.some((code) => hasErrorCode(error, code))) {
      throw error;
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!UNSYNCABLE_DIRECTORY.some((code) => hasErrorCode(error, code))) {
      throw error;
    }
  }
}

/**
 * The parsed JSON at `path`, or `undefined` when the file does not exist.
 * Strict otherwise: an unreadable file or invalid JSON throws, because the
 * callers of this variant must not mistake damage for absence.
 */
export async function readJsonFile(path: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  return JSON.parse(contents);
}
