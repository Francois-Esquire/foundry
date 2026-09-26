import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WorkspaceSystem } from "@foundry/workspaces";
import type { git } from "@foundry/workspaces/git";
import { Git } from "@foundry/workspaces/git";
import type { directory } from "@foundry/workspaces/node";

import type { ManagerArgs } from "../bindings";
import { current } from "../run-scope";
import type { WorkspaceHandle, Workspaces } from "../types";

/**
 * Directories, through the workspaces catalogue. `current` is the config's
 * own directory and never loads until a method needs it. `git` throws with a
 * clear message outside a repository. A worktree callback runs with the
 * frame's working directory narrowed to the worktree, so sessions and
 * sandboxes opened inside inherit it without being told.
 */

export type Catalogue = WorkspaceSystem<
  [ReturnType<typeof directory>, ReturnType<typeof git>]
>;

type Loaded = Awaited<ReturnType<Catalogue["load"]>>;
type GitOptions = NonNullable<Parameters<typeof Git.at>[1]>;

export interface WorkspacesDeps {
  readonly catalogue: Catalogue;
  /** Passed to `Git.at`; `--dry` echoes instead of running git. */
  readonly gitOptions?: GitOptions;
  /** The config's directory. */
  readonly root: string;
  /**
   * Where worktrees are cut when the caller names no `home`. Quirks owns it
   * so sandboxes may mount what is inside; the OS temp dir would not be
   * trusted.
   */
  readonly worktreeHome?: string;
}

/** The nearest enclosing directory with a `.git`, or undefined. */
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

/** Forward everything; run a worktree callback under its own working directory. */
function wrapGit(target: Git, worktreeHome: string | undefined): Git {
  return new Proxy(target, {
    get(object, property) {
      if (property === "withWorktree") {
        const withWorktree: Git["withWorktree"] = (options, body) => {
          const home = options.home ?? worktreeHome;
          if (home !== undefined) {
            mkdirSync(home, { recursive: true });
          }
          return object.withWorktree(
            home === undefined ? options : { ...options, home },
            (worktree) => {
              const store = current.getStore();
              return store
                ? current.run({ ...store, cwd: worktree.root }, () =>
                    body(worktree)
                  )
                : body(worktree);
            }
          );
        };
        return withWorktree;
      }
      const value = Reflect.get(object, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

function handle(
  root: string,
  loaded: () => Promise<Loaded>,
  gitOf: () => Git | undefined,
  worktreeHome: string | undefined
): WorkspaceHandle {
  return {
    async files() {
      const files = await (await loaded()).files();
      return files.map((file: { readonly path: string }) => file.path);
    },
    get git() {
      const found = gitOf();
      if (!found) {
        throw new Error(
          `${root} is not a git repository; workspaces.*.git needs one`
        );
      }
      return wrapGit(found, worktreeHome);
    },
    root,
  };
}

export function workspacesManager(
  deps: WorkspacesDeps
): (args: ManagerArgs) => Workspaces {
  const load = (path: string) =>
    deps.catalogue.load({ path: resolve(deps.root, path) });
  let currentLoaded: Promise<Loaded> | undefined;
  const currentHandle = handle(
    deps.root,
    () => {
      currentLoaded ??= load(".");
      return currentLoaded;
    },
    () =>
      repositoryRoot(deps.root)
        ? Git.at(deps.root, deps.gitOptions ?? {})
        : undefined,
    deps.worktreeHome
  );
  return () => ({
    current: currentHandle,
    async load(ref) {
      const workspace = await load(ref.path);
      return handle(
        workspace.root,
        () => Promise.resolve(workspace),
        () => workspace.git,
        deps.worktreeHome
      );
    },
  });
}
