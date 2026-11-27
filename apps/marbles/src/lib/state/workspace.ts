import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { sha256HexSync } from "~/lib/hash";

export interface Workspace {
  readonly dir: string;
  readonly id: string;
  readonly root: string;
}

export interface WorkspaceRecord {
  readonly config: string | null;
  readonly cwd: string;
  readonly firstSeen: string;
  readonly hosted: boolean;
  readonly id: string;
  readonly lastSeen: string;
  readonly root: string;
}

export function workspaceState(state: string, root: string): Workspace {
  const canonical = realpathSync(root);
  const id = sha256HexSync(canonical).slice(0, 12);
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
