import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WorkspaceSystem } from "@foundry/workspaces";
import { Git, git } from "@foundry/workspaces/git";
import { directory } from "@foundry/workspaces/node";
import { nodeObserver } from "@foundry/workspaces/node/watch";
import type { WorkspaceStore } from "@foundry/workspaces/store";
import type { ExecutionContext } from "~/lib/execution-context";
import { withinContext } from "~/lib/execution-context";

import type { ManagerArgs } from "../bindings";
import { current } from "../run-scope";
import type {
  LoadedWorkspace,
  WorkspaceDefinition,
  WorkspaceHandle,
  Workspaces,
} from "../types";

export type Catalogue = WorkspaceSystem<
  [ReturnType<typeof directory>, ReturnType<typeof git>]
>;

type Loaded = Awaited<ReturnType<Catalogue["load"]>>;
export type GitOptions = NonNullable<Parameters<typeof Git.at>[1]>;

export function localCatalogue(
  gitOptions: GitOptions,
  store?: WorkspaceStore
): Catalogue {
  return new WorkspaceSystem(store === undefined ? {} : { store }).extend(
    directory({ observer: nodeObserver }),
    git(gitOptions)
  );
}

export interface WorkspacesDeps {
  readonly catalogue: Catalogue;
  readonly context?: ExecutionContext;
  readonly gitOptions?: GitOptions;
  readonly root: string;
  readonly worktreeHome?: string;
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

type WorktreeOptions = Parameters<Git["worktree"]>[0];

function wrapGit<G extends Git>(
  target: G,
  worktreeHome: string | undefined,
  context: ExecutionContext | undefined
): G {
  const withHome = (options: WorktreeOptions): WorktreeOptions => {
    const home = options.home ?? worktreeHome;
    if (home === undefined) {
      return options;
    }
    mkdirSync(home, { recursive: true });
    return { ...options, home };
  };
  const wrap = <W extends Git>(worktree: W) =>
    wrapGit(worktree, worktreeHome, context);
  const overrides: Partial<Git> = {
    withWorktree: (options, body) =>
      target.withWorktree(withHome(options), (worktree) => {
        const wrapped = wrap(worktree);
        const store = current.getStore();
        return store
          ? current.run({ ...store, cwd: worktree.root }, () => body(wrapped))
          : withinContext(context, () => body(wrapped));
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

function handle(
  root: string,
  loaded: () => Promise<Loaded>,
  gitOf: () => Git | undefined,
  worktreeHome: string | undefined,
  context: ExecutionContext | undefined
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
      return wrapGit(found, worktreeHome, context);
    },
  });
  return target as unknown as WorkspaceHandle;
}

export class WorkspacesManager implements Workspaces {
  readonly #deps: WorkspacesDeps;
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
      deps.worktreeHome,
      deps.context
    );
  }

  get system(): Catalogue {
    return this.#deps.catalogue;
  }

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
        this.#deps.worktreeHome,
        this.#deps.context
      ),
      { id: workspace.id, source: workspace.source }
    );
  }

  scoped(_args?: ManagerArgs): Workspaces {
    return { current: this.current, load: (ref) => this.load(ref) };
  }

  async close(): Promise<void> {
    await this.#deps.catalogue.closeAll();
  }
}
