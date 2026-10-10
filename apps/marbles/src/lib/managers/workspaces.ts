import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WorkspaceSystem } from "@foundry/workspaces";
import type { git } from "@foundry/workspaces/git";
import { Git } from "@foundry/workspaces/git";
import type { directory } from "@foundry/workspaces/node";

import type { ManagerArgs } from "../bindings";
import { current } from "../run-scope";
import type {
  LoadedWorkspace,
  WorkspaceDefinition,
  WorkspaceHandle,
  Workspaces,
} from "../types";

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
export type GitOptions = NonNullable<Parameters<typeof Git.at>[1]>;

export interface WorkspacesDeps {
  readonly catalogue: Catalogue;
  /** Passed to `Git.at`; `--dry-run` echoes instead of running git. */
  readonly gitOptions?: GitOptions;
  /** The config's directory. */
  readonly root: string;
  /**
   * Where worktrees are cut when the caller names no `home`. Marbles owns it
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

type WorktreeOptions = Parameters<Git["worktree"]>[0];

/**
 * Forward everything, with Marbles' defaults on every worktree call: a
 * worktree is cut under `worktreeHome` unless the call names a `home`, and
 * each worktree handed back gets the same defaults for its own calls. A
 * worktree callback also runs under the worktree as its working directory.
 */
function wrapGit<G extends Git>(
  target: G,
  worktreeHome: string | undefined
): G {
  const withHome = (options: WorktreeOptions): WorktreeOptions => {
    const home = options.home ?? worktreeHome;
    if (home === undefined) {
      return options;
    }
    mkdirSync(home, { recursive: true });
    return { ...options, home };
  };
  const wrap = <W extends Git>(worktree: W) => wrapGit(worktree, worktreeHome);
  const overrides: Partial<Git> = {
    withWorktree: (options, body) =>
      target.withWorktree(withHome(options), (worktree) => {
        const wrapped = wrap(worktree);
        const store = current.getStore();
        return store
          ? current.run({ ...store, cwd: worktree.root }, () => body(wrapped))
          : body(wrapped);
      }),
    worktree: async (options) => wrap(await target.worktree(withHome(options))),
    worktrees: async () => (await target.worktrees()).map(wrap),
  };
  return new Proxy(target, {
    get(object, property) {
      if (Object.hasOwn(overrides, property)) {
        return Reflect.get(overrides, property);
      }
      const value = Reflect.get(object, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

/**
 * The package Workspace's methods a handle passes through. `rename` and
 * `remove` change the workspace registry, so they stay with the host.
 */
export const WORKSPACE_METHODS = [
  "createFile",
  "entries",
  "files",
  "read",
  "refresh",
  "registration",
  "save",
  "scan",
  "summary",
] as const satisfies readonly (keyof Loaded)[];

type Method = (...args: unknown[]) => Promise<unknown>;

/**
 * A handle over a workspace that may not be loaded yet: each method loads
 * it, once, then calls the package's own. `root` and `git` need no load.
 */
function handle(
  root: string,
  loaded: () => Promise<Loaded>,
  gitOf: () => Git | undefined,
  worktreeHome: string | undefined
): WorkspaceHandle {
  const target: Record<string, unknown> = { root };
  for (const name of WORKSPACE_METHODS) {
    target[name] = async (...args: unknown[]) => {
      const workspace = await loaded();
      return (Reflect.get(workspace, name) as Method).apply(workspace, args);
    };
  }
  Object.defineProperty(target, "git", {
    enumerable: true,
    get() {
      const found = gitOf();
      if (!found) {
        throw new Error(
          `${root} is not a git repository; workspaces.*.git needs one`
        );
      }
      return wrapGit(found, worktreeHome);
    },
  });
  return target as unknown as WorkspaceHandle;
}

export class WorkspacesManager implements Workspaces {
  readonly #deps: WorkspacesDeps;
  /** The root workspace; nothing is read until a method needs it. */
  readonly current: WorkspaceHandle;

  constructor(deps: WorkspacesDeps) {
    this.#deps = deps;
    let currentLoaded: Promise<Loaded> | undefined;
    this.current = handle(
      deps.root,
      () => {
        currentLoaded ??= this.#load(".");
        return currentLoaded;
      },
      () =>
        repositoryRoot(deps.root)
          ? Git.at(deps.root, deps.gitOptions ?? {})
          : undefined,
      deps.worktreeHome
    );
  }

  /** The workspace system this manager was built over. */
  get system(): Catalogue {
    return this.#deps.catalogue;
  }

  /** The workspace root. */
  get root(): string {
    return this.#deps.root;
  }

  #load(path: string): Promise<Loaded> {
    return this.#deps.catalogue.load({ path: resolve(this.#deps.root, path) });
  }

  async load(
    ref: WorkspaceDefinition | { readonly path: string }
  ): Promise<LoadedWorkspace> {
    const workspace = await this.#load(ref.path);
    return Object.assign(
      handle(
        workspace.root,
        () => Promise.resolve(workspace),
        () => workspace.git,
        this.#deps.worktreeHome
      ),
      { id: workspace.id, source: workspace.source }
    );
  }

  /** What a step body sees. Nothing here is per frame; the argument keeps the four managers alike. */
  scoped(_args?: ManagerArgs): Workspaces {
    return { current: this.current, load: (ref) => this.load(ref) };
  }

  async close(): Promise<void> {
    await this.#deps.catalogue.closeAll();
  }
}
