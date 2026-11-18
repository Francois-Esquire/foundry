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
const ABANDONED_EMPTY_MS = 30_000;

export interface TryFileLockOptions {
  readonly breakStale?: boolean;
  readonly mode?: number;
}

export interface FileLockOptions extends TryFileLockOptions {
  readonly retryMs?: number;
  readonly waitMs?: number;
}

export interface FileLock {
  release(): void;
}

export interface FileLockHolder {
  readonly empty?: true;
  readonly holder: number | undefined;
  readonly owner?: ProcessIdentity;
}

export class FileLockTimeoutError extends Error {
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

type LockFile =
  | { readonly kind: "missing" }
  | { readonly kind: "holder"; readonly owner: ProcessIdentity }
  | { readonly kind: "empty"; readonly ino: number; readonly mtimeMs: number }
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

export function tryFileLock(
  path: string,
  options: TryFileLockOptions = {}
): FileLock | FileLockHolder {
  const { breakStale = false, mode = 0o600 } = options;
  if (create(path, mode)) {
    return { release: releaser(path) };
  }
  const seen = readLock(path);
  const freed = seen.kind === "missing";
  const retry =
    freed ||
    (breakStale && abandoned(seen) && breakStaleLock(path, seen, mode));
  if (retry && create(path, mode)) {
    return { release: releaser(path) };
  }
  return heldBy(readLock(path));
}

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
