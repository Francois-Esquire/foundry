import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

export interface Workspace {
  /** `<state>/<id>`: runs, schedules, locks and sessions all live under it. */
  readonly dir: string;
  readonly id: string;
  readonly root: string;
}

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

export function workspaceAt(
  state: string,
  id: string,
  root: string
): Workspace {
  return { dir: join(state, id), id, root };
}

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
