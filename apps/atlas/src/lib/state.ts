import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isMissingPath, writeFileAtomicSync } from "@foundry/lib/atomic-file";
import type { FileLockHolder } from "@foundry/lib/file-lock";
import { processAlive, tryFileLock } from "@foundry/lib/file-lock";
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

/** The workspace root resolved through symlinks; it must exist and be a directory. */
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
