import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** One workspace's resolved root, and the output and cache of its state directory. */
export interface WorkspaceState {
  /** Per-package results and the workspace fingerprint. */
  cache: string;
  /** The directory the dataset is saved in. */
  output: string;
  /** The workspace root, resolved through symlinks. */
  root: string;
}

const DEFAULT_STATE_ROOT = join(homedir(), ".foundry", "atlas");

/** The workspace root resolved through symlinks; it must be a directory. */
export async function resolveRoot(target: string): Promise<string> {
  const root = await realpath(resolve(target));
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
  const id = createHash("sha256").update(resolved).digest("hex");
  const directory = join(resolve(state), id);
  return {
    cache: join(directory, "cache"),
    output: join(directory, "output"),
    root: resolved,
  };
}
