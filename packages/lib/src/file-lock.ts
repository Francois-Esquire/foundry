import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";

import { hasErrorCode, writeFileAtomicSync } from "./atomic-file";
import {
  isGone,
  type ProcessIdentity,
  sameProcess,
  thisProcess,
} from "./process-identity";

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
  readonly holder: number | undefined;
  readonly owner?: ProcessIdentity;
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

/** A lock file as one read finds it. */
type LockFile =
  | { readonly kind: "missing" }
  | { readonly kind: "holder"; readonly owner: ProcessIdentity }
  | { readonly kind: "empty"; readonly ino: number; readonly mtimeMs: number }
  /** Unreadable, or not a pid: for a person to look at. */
  | { readonly kind: "other" };

function absentOr(error: unknown): LockFile {
  return { kind: hasErrorCode(error, "ENOENT") ? "missing" : "other" };
}

function readLock(path: string): LockFile {
  let contents: string;
  let file: ReturnType<typeof statSync>;
  try {
    contents = readFileSync(path, "utf8");
    file = statSync(path);
  } catch (error) {
    return absentOr(error);
  }
  if (contents === "") {
    return { ino: file.ino, kind: "empty", mtimeMs: file.mtimeMs };
  }
  const pid = Number(contents);
  return Number.isInteger(pid) && pid > 0
    ? {
        kind: "holder",
        owner: { pid, started: ownerStart(path, pid, file) },
      }
    : { kind: "other" };
}

interface OwnerNote {
  readonly ctimeMs: number;
  readonly ino: number;
  readonly pid: number;
  readonly started: string;
}

function ownerNotePath(path: string): string {
  return `${path}.owner`;
}

function ownerStart(
  path: string,
  pid: number,
  file: { readonly ctimeMs: number; readonly ino: number }
): string | null {
  let note: Partial<OwnerNote>;
  try {
    note = JSON.parse(readFileSync(ownerNotePath(path), "utf8"));
  } catch {
    return null;
  }
  return note.ino === file.ino &&
    note.ctimeMs === file.ctimeMs &&
    note.pid === pid &&
    typeof note.started === "string"
    ? note.started
    : null;
}

function noteOwner(path: string, mode: number, file: OwnerNote): void {
  try {
    writeFileAtomicSync(ownerNotePath(path), JSON.stringify(file), { mode });
  } catch {
    // Without it the lock is judged by its pid alone, as earlier versions judge it.
  }
}

/** Whether two reads found the same lock: one holder, or one untouched empty file. */
function sameLock(a: LockFile, b: LockFile): boolean {
  if (a.kind === "holder" && b.kind === "holder") {
    return a.owner.pid === b.owner.pid && a.owner.started === b.owner.started;
  }
  if (a.kind === "empty" && b.kind === "empty") {
    return a.ino === b.ino && a.mtimeMs === b.mtimeMs;
  }
  return false;
}

function abandoned(lock: LockFile): boolean {
  switch (lock.kind) {
    case "holder":
      return isGone(lock.owner);
    case "empty":
      return Date.now() - lock.mtimeMs > ABANDONED_EMPTY_MS;
    default:
      return false;
  }
}

function heldBy(lock: LockFile): FileLockHolder {
  switch (lock.kind) {
    case "holder":
      return { holder: lock.owner.pid, owner: lock.owner };
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
  return lockOwner(path)?.pid;
}

export function lockOwner(path: string): ProcessIdentity | undefined {
  const lock = readLock(path);
  return lock.kind === "holder" ? lock.owner : undefined;
}

export function holdsLock(path: string): boolean {
  const owner = lockOwner(path);
  return owner !== undefined && sameProcess(owner, thisProcess());
}

export function lockContents(): string {
  return String(thisProcess().pid);
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
  let written: { readonly ctimeMs: number; readonly ino: number };
  try {
    try {
      writeSync(file, lockContents());
      written = fstatSync(file);
    } finally {
      closeSync(file);
    }
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  try {
    if (statSync(path).ino !== written.ino) {
      return false;
    }
  } catch {
    return false;
  }
  const { pid, started } = thisProcess();
  if (started !== null) {
    noteOwner(path, mode, {
      ctimeMs: written.ctimeMs,
      ino: written.ino,
      pid,
      started,
    });
  }
  return true;
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
    if (holdsLock(path)) {
      rmSync(ownerNotePath(path), { force: true });
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
