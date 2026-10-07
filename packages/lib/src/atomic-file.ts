/**
 * Whole-file writes that a concurrent reader never sees half done, and the
 * reads that pair with them.
 *
 * Node-bound: import it from main-process code only.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** True when `error` is a Node system error carrying this `code` (ENOENT, EEXIST, ...). */
export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
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
  /** Mode of the new file. Defaults to 0o666 less the umask, like `writeFile`. */
  readonly mode?: number;
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
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    if (fsync) {
      const file = await open(temporary, "wx", mode);
      try {
        await file.writeFile(contents);
        await file.sync();
      } finally {
        await file.close();
      }
    } else {
      await writeFile(temporary, contents, {
        flag: "wx",
        ...(mode === undefined ? {} : { mode }),
      });
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  if (fsync) {
    await syncDirectory(dirname(path));
  }
}

/** Platforms that cannot open or flush a directory (Windows, some filesystems) say so with these. */
const UNSYNCABLE_DIRECTORY = ["EINVAL", "EISDIR", "ENOTSUP", "EPERM"];

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
