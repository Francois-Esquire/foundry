/**
 * Cross-process exclusion through a lock file created with `wx`: whoever
 * creates it holds the lock until it removes it. The file records the
 * holder's pid.
 *
 * One protocol, two ways in: `tryFileLock` takes the lock now or says who
 * has it, for callers that skip rather than wait; `acquireFileLock` retries
 * that same attempt until a deadline. Each step of an attempt is a
 * synchronous file operation, so within one process no two attempts
 * interleave; across processes, the steps below are what keep them apart.
 *
 * Node-bound: import it from main-process code only. Exclusion within one
 * process is the caller's job (see `KeyedQueue`); this lock is not reentrant.
 */

import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";

import { hasErrorCode } from "./atomic-file";

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_RETRY_MS = 10;
/**
 * How long a lock file may stay empty before it counts as abandoned. Its
 * creator writes its pid right after creating it, so one still empty this
 * long was left by a process that died in between (or wrote it before a
 * power loss reached the disk).
 */
const ABANDONED_EMPTY_MS = 30_000;

export interface TryFileLockOptions {
  /**
   * Replace a lock whose recorded holder is no longer running, or that has
   * recorded no holder for 30s. Leave it off where a crashed writer may have
   * left damage a person should look at first. Breakers take turns (see
   * `breakStaleLock`), so exactly one of them takes a stale lock over.
   */
  readonly breakStale?: boolean;
  /** Mode of the lock file. Defaults to 0o600. */
  readonly mode?: number;
}

export interface FileLockOptions extends TryFileLockOptions {
  /** How often to try again while another process holds it. Defaults to 10ms. */
  readonly retryMs?: number;
  /** How long to wait for the holder before giving up. Defaults to 5s. */
  readonly waitMs?: number;
}

/** A lock this process holds. `release` runs once (see `releaser`). */
export interface FileLock {
  release(): void;
}

/** A lock someone else holds. */
export interface FileLockHolder {
  /**
   * The file is empty: its creator has not written its pid yet. With
   * `breakStale`, one left empty for 30s is broken.
   */
  readonly empty?: true;
  /**
   * The pid the file records, or `undefined` when it records none. A file
   * that is neither empty nor a pid (unreadable, or written by hand) is
   * never broken.
   */
  readonly holder: number | undefined;
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

/** A lock file as one read finds it. */
type LockFile =
  | { readonly kind: "missing" }
  | { readonly kind: "holder"; readonly pid: number }
  | { readonly kind: "empty"; readonly ino: number; readonly mtimeMs: number }
  /** Unreadable, or not a pid: for a person to look at. */
  | { readonly kind: "other" };

function absentOr(error: unknown): LockFile {
  return { kind: hasErrorCode(error, "ENOENT") ? "missing" : "other" };
}

function readLock(path: string): LockFile {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    return absentOr(error);
  }
  if (contents === "") {
    try {
      const { ino, mtimeMs } = statSync(path);
      return { ino, kind: "empty", mtimeMs };
    } catch (error) {
      return absentOr(error);
    }
  }
  const pid = Number(contents);
  return Number.isInteger(pid) && pid > 0
    ? { kind: "holder", pid }
    : { kind: "other" };
}

/** Whether two reads found the same lock: one holder, or one untouched empty file. */
function sameLock(a: LockFile, b: LockFile): boolean {
  if (a.kind === "holder" && b.kind === "holder") {
    return a.pid === b.pid;
  }
  if (a.kind === "empty" && b.kind === "empty") {
    return a.ino === b.ino && a.mtimeMs === b.mtimeMs;
  }
  return false;
}

function abandoned(lock: LockFile): boolean {
  switch (lock.kind) {
    case "holder":
      return !processAlive(lock.pid);
    case "empty":
      return Date.now() - lock.mtimeMs > ABANDONED_EMPTY_MS;
    default:
      return false;
  }
}

function heldBy(lock: LockFile): FileLockHolder {
  switch (lock.kind) {
    case "holder":
      return { holder: lock.pid };
    case "empty":
      return { empty: true, holder: undefined };
    default:
      return { holder: undefined };
  }
}

/**
 * The pid a lock file records, or `undefined` when there is no file (it was
 * released between an attempt and this read) or it records no pid.
 */
export function lockHolder(path: string): number | undefined {
  const lock = readLock(path);
  return lock.kind === "holder" ? lock.pid : undefined;
}

/**
 * Create `path` exclusively and record this process in it. `false` when it
 * already exists. A lock whose pid could not be written is removed again, so
 * it does not sit empty until it counts as abandoned. `false` too when the
 * file was broken as abandoned while this process stalled between creating
 * it and writing its pid, and another has taken the lock since.
 */
function create(path: string, mode: number): boolean {
  let file: number;
  try {
    file = openSync(path, "wx", mode);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
  let ino: number;
  try {
    try {
      writeSync(file, String(process.pid));
      ({ ino } = fstatSync(file));
    } finally {
      closeSync(file);
    }
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  try {
    return statSync(path).ino === ino;
  } catch {
    return false;
  }
}

/**
 * Remove the lock at `path` if it is still the abandoned lock `seen`: the
 * same exited holder, or the same untouched empty file. Breakers take turns
 * through `${path}.break`, and each re-reads the lock while it has that
 * turn. Without that, two processes that both judged one lock abandoned
 * could each remove a lock, the second removing the one the first had just
 * taken, and both would hold it. `false` when another process has the turn.
 *
 * A process that dies holding `.break` leaves breaking switched off for this
 * lock: abandoned locks then stay held until someone removes the `.break`
 * file. That fails safe.
 */
function breakStaleLock(path: string, seen: LockFile, mode: number): boolean {
  const turn = `${path}.break`;
  try {
    closeSync(openSync(turn, "wx", mode));
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
  try {
    if (sameLock(readLock(path), seen)) {
      rmSync(path, { force: true });
    }
    return true;
  } finally {
    rmSync(turn, { force: true });
  }
}

/**
 * The release for a lock this process created. It runs once, and removes the
 * file only while it still names this process, so a late or repeated call
 * cannot remove a lock someone else has taken since.
 */
function releaser(path: string): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (lockHolder(path) === process.pid) {
      rmSync(path, { force: true });
    }
  };
}

/**
 * Take the lock at `path` now, or say who holds it. With `breakStale`, an
 * abandoned lock (its holder exited, or it stayed empty for 30s) is broken
 * and taken over in the same call.
 */
export function tryFileLock(
  path: string,
  options: TryFileLockOptions = {}
): FileLock | FileLockHolder {
  const { breakStale = false, mode = 0o600 } = options;
  if (create(path, mode)) {
    return { release: releaser(path) };
  }
  const seen = readLock(path);
  // Released between the attempt and the read: free again.
  const freed = seen.kind === "missing";
  const retry =
    freed ||
    (breakStale && abandoned(seen) && breakStaleLock(path, seen, mode));
  if (retry && create(path, mode)) {
    return { release: releaser(path) };
  }
  // Another process took it over first, or has the turn to break it.
  return heldBy(readLock(path));
}

/** Take the lock at `path`, waiting for its holder; resolves to its release. */
export async function acquireFileLock(
  path: string,
  options: FileLockOptions = {}
): Promise<() => Promise<void>> {
  const { retryMs = DEFAULT_RETRY_MS, waitMs = DEFAULT_WAIT_MS } = options;
  const deadline = performance.now() + waitMs;
  for (;;) {
    const attempt = tryFileLock(path, options);
    if ("release" in attempt) {
      return () => {
        attempt.release();
        return Promise.resolve();
      };
    }
    if (performance.now() >= deadline) {
      throw new FileLockTimeoutError(path, attempt.holder);
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
