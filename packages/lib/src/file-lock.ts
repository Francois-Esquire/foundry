/**
 * Cross-process exclusion through a lock file created with `wx`: whoever
 * creates it holds the lock until it removes it. The file records the
 * holder's pid.
 *
 * Node-bound: import it from main-process code only. Exclusion within one
 * process is the caller's job (see `KeyedQueue`); this lock is not reentrant.
 */

import { open, readFile, rm } from "node:fs/promises";

import { hasErrorCode } from "./atomic-file";

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_RETRY_MS = 10;

export interface FileLockOptions {
  /**
   * Replace a lock whose recorded holder is no longer running. Leave it off
   * where a crashed writer may have left damage a person should look at
   * first. Two waiters can both judge one dead holder's lock stale; the
   * window is the instant between that judgement and the removal.
   */
  readonly breakStale?: boolean;
  /** Mode of the lock file. Defaults to 0o600. */
  readonly mode?: number;
  /** How often to try again while another process holds it. Defaults to 10ms. */
  readonly retryMs?: number;
  /** How long to wait for the holder before giving up. Defaults to 5s. */
  readonly waitMs?: number;
}

/** Thrown when the lock stays held past the wait. */
export class FileLockTimeoutError extends Error {
  /** The pid recorded in the lock file, when it records one. */
  readonly holder: number | undefined;
  readonly path: string;

  constructor(path: string, holder: number | undefined) {
    super(
      holder === undefined
        ? `${path} is locked`
        : `${path} is locked by process ${String(holder)}`
    );
    this.name = "FileLockTimeoutError";
    this.holder = holder;
    this.path = path;
  }
}

/** `EPERM` counts as running: the pid exists but belongs to another user. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

async function holderOf(path: string): Promise<number | undefined> {
  // Unreadable when it was released between our attempt and this read.
  const contents = await readFile(path, "utf8").catch(() => "");
  const pid = Number(contents);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Take the lock at `path`, waiting for its holder; resolves to its release. */
export async function acquireFileLock(
  path: string,
  options: FileLockOptions = {}
): Promise<() => Promise<void>> {
  const {
    breakStale = false,
    mode = 0o600,
    retryMs = DEFAULT_RETRY_MS,
    waitMs = DEFAULT_WAIT_MS,
  } = options;
  const deadline = performance.now() + waitMs;
  for (;;) {
    try {
      const file = await open(path, "wx", mode);
      try {
        await file.writeFile(String(process.pid));
      } finally {
        await file.close();
      }
      return () => rm(path, { force: true });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    const holder = await holderOf(path);
    if (breakStale && holder !== undefined && !processAlive(holder)) {
      await rm(path, { force: true });
      continue;
    }
    if (performance.now() >= deadline) {
      throw new FileLockTimeoutError(path, holder);
    }
    await new Promise<void>((done) => setTimeout(done, retryMs));
  }
}

/** Run `operation` holding the lock at `path`, releasing it however it ends. */
export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const release = await acquireFileLock(path, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}
