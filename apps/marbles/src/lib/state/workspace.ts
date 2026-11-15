import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * State is scoped per workspace: the directory the config lives in, or the
 * cwd without one. Each gets `<state>/<id>/` where `id` hashes the canonical
 * root. Which workspaces this machine has run, and which of them the
 * Marbles process hosts, is recorded in the Marbles database
 * (`WorkspaceRegistry`), keyed by the same id.
 */

export interface Workspace {
  /** `<state>/<id>`: each run's output and worktrees live under it. */
  readonly dir: string;
  readonly id: string;
  readonly root: string;
}

/** What the registry records of a workspace. */
export interface WorkspaceRecord {
  readonly config: string | null;
  readonly firstSeen: string;
  /** The Marbles process starts a worker for it. */
  readonly hosted: boolean;
  readonly id: string;
  readonly lastSeen: string;
  readonly root: string;
}

export function workspaceState(state: string, root: string): Workspace {
  const canonical = realpathSync(root);
  const id = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return workspaceAt(state, id, canonical);
}

/** The workspace `id` under `state`, rooted at `root`, as it was recorded. */
export function workspaceAt(
  state: string,
  id: string,
  root: string
): Workspace {
  return { dir: join(state, id), id, root };
}

/**
 * Whether `<state>/<id>` keeps what is written under it inside `state`:
 * nothing is there yet, so it is made there on first use, or it is a real
 * directory, the same one once every link above it resolves. A symlink,
 * even a dangling one, is neither.
 */
export function insideState(state: string, id: string): boolean {
  const dir = join(state, id);
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat === undefined) {
    return true;
  }
  return (
    stat.isDirectory() && realpathSync(dir) === join(realpathSync(state), id)
  );
}
