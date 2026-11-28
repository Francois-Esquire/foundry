import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Workspaces as WorkspaceRuntime } from "@foundry/workspaces";
import type { directory } from "@foundry/workspaces/node";
import { workspaces } from "@foundry/workspaces/node";
import { Git, git } from "@foundry/workspaces/node/git";
import type { WorkspaceStore } from "@foundry/workspaces/store";
import type { WorkspaceGit } from "~/lib/definitions/types";

export type LocalWorkspaces = WorkspaceRuntime<
  [ReturnType<typeof directory>, ReturnType<typeof git>]
>;

export type GitOptions = NonNullable<Parameters<typeof Git.at>[1]>;

export function localWorkspaces(
  gitOptions: GitOptions,
  store?: WorkspaceStore
): LocalWorkspaces {
  return workspaces(store === undefined ? {} : { store }).extend(
    git(gitOptions)
  );
}

export function repositoryRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function nodeGitAt(
  gitOptions: GitOptions = {}
): (root: string) => WorkspaceGit | undefined {
  return (root) =>
    repositoryRoot(root) ? Git.at(root, gitOptions) : undefined;
}

export function ensureWorktreeDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
