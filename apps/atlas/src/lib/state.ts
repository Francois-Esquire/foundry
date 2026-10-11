import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { isMissingPath, writeFileAtomicSync } from "@foundry/lib/atomic-file";
import type { FileLockHolder } from "@foundry/lib/file-lock";
import { processAlive, tryFileLock } from "@foundry/lib/file-lock";
import { byCodeUnit } from "@foundry/lib/ordering";
import { isFilesystemPathWithin } from "@foundry/lib/paths";
import { version } from "../../package.json" with { type: "json" };

/** One workspace's resolved root, and the paths of its state directory. */
export interface WorkspaceState {
  /** Per-package results and the workspace fingerprint. */
  cache: string;
  /** The state directory, `<state root>/<id>`. */
  directory: string;
  /** The workspace id, which names the state directory: the first 12 hex digits of the SHA-256 of `root`, as Marbles names its state directories. */
  id: string;
  /** The directory the dataset is saved in. */
  output: string;
  /** The workspace root, resolved through symlinks. */
  root: string;
}

/** The state directory's `workspace.json`: the workspace it belongs to, so the state root can be listed. */
interface WorkspaceRecord {
  /** The Atlas version that last saved the dataset; set with `lastScannedAt`. */
  atlasVersion?: string;
  id: string;
  /** When a scan last saved the dataset, ISO 8601; set with `atlasVersion`. */
  lastScannedAt?: string;
  /** The workspace root, resolved through symlinks. */
  root: string;
  /** The record's own schema. */
  schemaVersion: 1;
}

const DEFAULT_STATE_ROOT = join(homedir(), ".foundry", "atlas");
const WORKSPACE_ID_LENGTH = 12;
/** By code unit, so the order is the same in every locale. */
const byResolvedRoot = byCodeUnit((state: WorkspaceState) => state.root);
const byString = byCodeUnit((value: string) => value);
const byDirectory = byCodeUnit((state: WorkspaceState) => state.directory);

/**
 * The workspace root resolved through symlinks; it must exist and be a
 * directory. It must stay `fs/promises` `realpath`, the native one: that
 * also gives a case-insensitive file system's own spelling of the path and
 * its Unicode normalization, so one directory has one id however it is
 * typed. It does not see through firmlinks or bind mounts.
 */
export async function resolveRoot(target: string): Promise<string> {
  const path = resolve(target);
  let root: string;
  try {
    root = await realpath(path);
  } catch (error) {
    if (isMissingPath(error)) {
      throw new Error(`Workspace path does not exist: ${path}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!(await stat(root)).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${root}`);
  }
  return root;
}

/** The state directory for a workspace; nothing is created. */
export async function workspaceState(
  root: string,
  state = DEFAULT_STATE_ROOT
): Promise<WorkspaceState> {
  const resolved = await resolveRoot(root);
  const id = createHash("sha256")
    .update(resolved)
    .digest("hex")
    .slice(0, WORKSPACE_ID_LENGTH);
  const directory = join(resolve(state), id);
  return {
    cache: join(directory, "cache"),
    directory,
    id,
    output: join(directory, "output"),
    root: resolved,
  };
}

/**
 * The workspaces of a collection: each path resolved through symlinks, a
 * workspace given twice kept once, in a canonical order (by resolved root),
 * each with its state directory. Refuses no workspaces at all, a path that
 * does not resolve (the first in the order given), and two workspaces that
 * overlap, since one would hold the other's files. Creates nothing.
 */
export async function resolveCollection(
  roots: readonly string[],
  state?: string
): Promise<WorkspaceState[]> {
  if (roots.length === 0) {
    throw new Error("A collection needs at least one workspace.");
  }
  const settled = await Promise.allSettled(
    roots.map((root) => workspaceState(root, state))
  );
  const byRoot = new Map<string, WorkspaceState>();
  for (const result of settled) {
    if (result.status === "rejected") {
      throw result.reason;
    }
    byRoot.set(result.value.root, result.value);
  }
  const workspaces = [...byRoot.values()].sort(byResolvedRoot);
  const overlap = overlapRefusal(workspaces.map((workspace) => workspace.root));
  if (overlap !== undefined) {
    throw new Error(overlap);
  }
  return workspaces;
}

/**
 * Why `roots`, resolved, cannot be one collection: the message naming the
 * first that holds another, or `undefined` when none does. Pure, so the CLI
 * refuses overlapping paths as a usage error with the library's words.
 */
export function overlapRefusal(roots: readonly string[]): string | undefined {
  const sorted = [...roots].sort(byString);
  // A root sorts before every root inside it, so only later ones can be inside.
  for (const [index, outer] of sorted.entries()) {
    const inner = sorted
      .slice(index + 1)
      .find((other) => isFilesystemPathWithin(outer, other, sep));
    if (inner !== undefined) {
      return `Workspace ${outer} holds workspace ${inner}; the workspaces of a collection cannot overlap.`;
    }
  }
}

/**
 * Takes the lock of every state directory, in the order of their paths, or
 * none: when one is held, the locks already taken are released and its
 * error is thrown, with any failure to release as its `cause`. Returns the
 * release of them all, which runs once and tries every lock before it
 * throws. `lock` is `lockState` unless a test stands in for it.
 */
export function lockStates(
  states: readonly WorkspaceState[],
  lock: (state: WorkspaceState) => () => void = lockState
): () => void {
  const releases: (() => void)[] = [];
  const releaseAll = (): void => releaseEach(releases.splice(0).reverse());
  const ordered = [...states].sort(byDirectory);
  try {
    for (const state of ordered) {
      releases.push(lock(state));
    }
  } catch (error) {
    try {
      releaseAll();
    } catch (failure) {
      throw withCause(error, failure);
    }
    throw error;
  }
  return releaseAll;
}

/** Runs every release, then throws what failed: the one error, or all of them. */
function releaseEach(releases: readonly (() => void)[]): void {
  const failures: unknown[] = [];
  for (const release of releases) {
    try {
      release();
    } catch (error) {
      failures.push(error);
    }
  }
  const [only, ...more] = failures;
  if (more.length > 0) {
    throw new AggregateError(
      failures,
      "Atlas could not release every workspace's lock."
    );
  }
  if (only !== undefined) {
    throw only;
  }
}

/** `error` with `cause` attached, when it is an `Error` without one; else a new error carrying both. */
function withCause(error: unknown, cause: unknown): Error {
  if (error instanceof Error && error.cause === undefined) {
    error.cause = cause;
    return error;
  }
  return new Error(String(error), { cause });
}

/**
 * Takes the state directory's lock, so one scan or apply at a time writes
 * it, and no export copies the dataset while one does, across processes and
 * within one. Throws without waiting when it is held, since a scan takes
 * minutes. A lock left by a process that has exited is taken over.
 * Returns the release, which runs once.
 */
export function lockState(state: WorkspaceState): () => void {
  mkdirSync(state.directory, { recursive: true });
  const path = join(state.directory, "lock");
  const attempt = tryFileLock(path, { breakStale: true });
  if ("release" in attempt) {
    return attempt.release;
  }
  throw new Error(heldMessage(state.root, path, attempt));
}

function heldMessage(
  root: string,
  path: string,
  { empty, holder }: FileLockHolder
): string {
  const workspace = `Workspace ${root}`;
  if (empty) {
    return `${workspace} is being scanned, exported, or applied by a process that is starting. Retry.`;
  }
  if (holder === undefined) {
    return `${workspace} is locked by an unknown process. If no scan, export, or apply is running, remove ${path}.`;
  }
  if (holder === process.pid) {
    return `${workspace} is being scanned, exported, or applied by this process.`;
  }
  if (processAlive(holder)) {
    // The holder is alive, so its lock is not removed: an apply holds it
    // while it writes and verifies sources.
    return `${workspace} is being scanned, exported, or applied by process ${holder}. Wait for it to finish, then retry.`;
  }
  // Only while another process has its turn to break the lock.
  return `${workspace} is locked by process ${holder}, which has exited; another scan, export, or apply is taking the lock over. Retry.`;
}

/** Records which workspace the state directory belongs to, unless a record is there already. */
export function recordWorkspace(state: WorkspaceState): void {
  if (!existsSync(recordPath(state))) {
    writeRecord(state, { id: state.id, root: state.root, schemaVersion: 1 });
  }
}

/** Records that a scan has just saved the workspace's dataset, and with which Atlas. */
export function recordSavedDataset(state: WorkspaceState): void {
  writeRecord(state, {
    atlasVersion: version,
    id: state.id,
    lastScannedAt: new Date().toISOString(),
    root: state.root,
    schemaVersion: 1,
  });
}

function recordPath(state: WorkspaceState): string {
  return join(state.directory, "workspace.json");
}

function writeRecord(state: WorkspaceState, record: WorkspaceRecord): void {
  writeFileAtomicSync(
    recordPath(state),
    `${JSON.stringify(record, null, 2)}\n`,
    { createDirectory: true }
  );
}
