import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  isMissingPath,
  writeFileAtomicSync,
} from "@foundry/lib/node/atomic-file";
import type { FileLockHolder } from "@foundry/lib/node/file-lock";
import { tryFileLock } from "@foundry/lib/node/file-lock";
import { processAlive } from "@foundry/lib/node/process-identity";
import { byCodeUnit } from "@foundry/lib/ordering";
import { isFilesystemPathWithin } from "@foundry/lib/paths";
import { version } from "../../package.json" with { type: "json" };

export interface WorkspaceState {
  cache: string;
  directory: string;
  id: string;
  output: string;
  root: string;
}

interface WorkspaceRecord {
  id: string;
  lastScannedAt?: string;
  root: string;
  schemaVersion: 1;
  spyglassVersion?: string;
}

const DEFAULT_STATE_ROOT = join(homedir(), ".foundry", "spyglass");
const LEGACY_STATE_ROOT = join(homedir(), ".foundry", "atlas");
const WORKSPACE_ID_LENGTH = 12;
const byResolvedRoot = byCodeUnit((state: WorkspaceState) => state.root);
const byString = byCodeUnit((value: string) => value);
const byDirectory = byCodeUnit((state: WorkspaceState) => state.directory);

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

export async function workspaceState(
  root: string,
  state?: string
): Promise<WorkspaceState> {
  const resolved = await resolveRoot(root);
  const id = createHash("sha256")
    .update(resolved)
    .digest("hex")
    .slice(0, WORKSPACE_ID_LENGTH);
  const current = join(resolve(state ?? DEFAULT_STATE_ROOT), id);
  const previous = join(LEGACY_STATE_ROOT, id);
  const directory =
    state === undefined && !existsSync(current) && existsSync(previous)
      ? previous
      : current;
  return {
    cache: join(directory, "cache"),
    directory,
    id,
    output: join(directory, "output"),
    root: resolved,
  };
}

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

export function overlapRefusal(roots: readonly string[]): string | undefined {
  const sorted = [...roots].sort(byString);
  for (const [index, outer] of sorted.entries()) {
    const inner = sorted
      .slice(index + 1)
      .find((other) => isFilesystemPathWithin(outer, other, sep));
    if (inner !== undefined) {
      return `Workspace ${outer} holds workspace ${inner}; the workspaces of a collection cannot overlap.`;
    }
  }
}

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
      "Spyglass could not release every workspace's lock."
    );
  }
  if (only !== undefined) {
    throw only;
  }
}

function withCause(error: unknown, cause: unknown): Error {
  if (error instanceof Error && error.cause === undefined) {
    error.cause = cause;
    return error;
  }
  return new Error(String(error), { cause });
}

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
    return `${workspace} is being scanned, exported, or applied by process ${holder}. Wait for it to finish, then retry.`;
  }
  return `${workspace} is locked by process ${holder}, which has exited; another scan, export, or apply is taking the lock over. Retry.`;
}

export function recordWorkspace(state: WorkspaceState): void {
  if (!existsSync(recordPath(state))) {
    writeRecord(state, { id: state.id, root: state.root, schemaVersion: 1 });
  }
}

export function recordSavedDataset(state: WorkspaceState): void {
  writeRecord(state, {
    id: state.id,
    lastScannedAt: new Date().toISOString(),
    root: state.root,
    schemaVersion: 1,
    spyglassVersion: version,
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
