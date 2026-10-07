/**
 * Cross-process exclusion through a lock file created with `wx`: whoever
 * creates it holds the lock until it removes it. The file records the
 * holder's pid.
 *
 * Node-bound: import it from main-process code only. Exclusion within one
 * process is the caller's job (see `KeyedQueue`); this lock is not reentrant.
 */

import type { FileHandle } from "node:fs/promises";
import { open, readFile, rm } from "node:fs/promises";

import { hasErrorCode } from "./atomic-file";

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_RETRY_MS = 10;

export interface FileLockOptions {
  /**
   * Replace a lock whose recorded holder is no longer running. Leave it off
   * where a crashed writer may have left damage a person should look at
   * first. Waiters break a stale lock one at a time (see `breakStaleLock`),
   * so exactly one of them takes it over.
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

/**
 * Create `path` exclusively and record this process in it. `false` when it
 * already exists. A lock whose pid could not be written is removed again:
 * left empty, it would name no holder and so could never be broken.
 */
async function create(path: string, mode: number): Promise<boolean> {
  let file: FileHandle;
  try {
    file = await open(path, "wx", mode);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
  try {
    try {
      await file.writeFile(String(process.pid));
    } finally {
      await file.close();
    }
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  return true;
}

/**
 * Remove the lock at `path` if it still names `holder`, a process that has
 * exited. Breakers take turns through `${path}.break`, and each re-reads the
 * holder while it has that turn. Without that, two waiters that both judged
 * one dead holder stale could each remove a lock, the second removing the
 * one the first had just taken, and both would hold it. `false` when another
 * waiter has the turn.
 *
 * A process that dies holding `.break` leaves breaking switched off for this
 * lock: stale locks then time out like live ones until someone removes the
 * `.break` file. That fails safe.
 */
async function breakStaleLock(
  path: string,
  holder: number,
  mode: number
): Promise<boolean> {
  const turn = `${path}.break`;
  try {
    const file = await open(turn, "wx", mode);
    await file.close();
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
  try {
    if ((await holderOf(path)) === holder) {
      await rm(path, { force: true });
    }
    return true;
  } finally {
    await rm(turn, { force: true });
  }
}

/**
 * The release for a lock this process created. It runs once, and removes the
 * file only while it still names this process, so a late or repeated call
 * cannot remove a lock someone else has taken since.
 */
function releaser(path: string): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    if ((await holderOf(path)) === process.pid) {
      await rm(path, { force: true });
    }
  };
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
    if (await create(path, mode)) {
      return releaser(path);
    }
    const holder = await holderOf(path);
    const stale = breakStale && holder !== undefined && !processAlive(holder);
    if (stale && (await breakStaleLock(path, holder, mode))) {
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
