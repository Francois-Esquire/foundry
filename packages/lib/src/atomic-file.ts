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

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function isMissingPath(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");
}

export interface AtomicWriteOptions {
  readonly createDirectory?: boolean;
  readonly directoryMode?: number;
  readonly fsync?: boolean;
  readonly mode?: number;
}

const DEFAULT_FILE_MODE = 0o666;

function temporaryBeside(path: string): string {
  return `${path}.${randomUUID()}.tmp`;
}

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
  readonly createDirectory?: boolean;
  readonly fsync?: boolean;
  readonly mode?: number;
}

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

const UNSYNCABLE_DIRECTORY = ["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"];

export function syncDirectorySync(path: string): void {
  try {
    syncFileSync(path);
  } catch (error) {
    if (!UNSYNCABLE_DIRECTORY.some((code) => hasErrorCode(error, code))) {
      throw error;
    }
  }
}

export async function syncDirectory(path: string): Promise<void> {
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
