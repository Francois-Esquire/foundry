import type { Workspace as PackageWorkspace } from "@foundry/workspaces";
import type { ManagerArgs } from "~/lib/definitions/bindings";
import type {
  LoadedWorkspace,
  ScopedWorkspaces,
  WorkspaceDefinition,
  WorkspaceGit,
  WorkspaceHandle,
  WorktreeOptions,
} from "~/lib/definitions/types";
import { WORKSPACE_METHODS } from "~/lib/managers/workspace-methods";
import type { ExecutionContext } from "~/lib/runs/context";
import { withinContext } from "~/lib/runs/context";
import { current } from "~/lib/runs/scope";

export type PortableWorkspace = Pick<
  PackageWorkspace,
  | "createFile"
  | "entries"
  | "files"
  | "id"
  | "read"
  | "refresh"
  | "registration"
  | "save"
  | "scan"
  | "source"
  | "summary"
> & {
  readonly git?: WorkspaceGit;
  readonly root: string;
};

export interface WorkspaceCatalogue {
  closeAll(): Promise<void>;
  load(input: { readonly path: string }): Promise<PortableWorkspace>;
}

export interface WorkspacesDeps {
  readonly catalogue?: WorkspaceCatalogue;
  readonly context?: ExecutionContext;
  readonly ensureDir?: (path: string) => void;
  readonly gitAt?: (root: string) => WorkspaceGit | undefined;
  readonly root: string;
  readonly worktreeHome?: string;
}

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") || path.startsWith("\\") || WINDOWS_ABSOLUTE.test(path)
  );
}

function normalizePosix(path: string): string {
  const absolute = path.startsWith("/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push("..");
      }
    } else {
      segments.push(segment);
    }
  }
  const joined = segments.join("/");
  if (absolute) {
    return `/${joined}`;
  }
  return joined || ".";
}

function resolveWorkspacePath(root: string, target: string): string {
  const raw = isAbsolutePath(target) ? target : `${root}/${target}`;
  return normalizePosix(raw.replaceAll("\\", "/"));
}

function wrapGit<G extends WorkspaceGit>(
  target: G,
  worktreeHome: string | undefined,
  context: ExecutionContext | undefined,
  ensureDir: ((path: string) => void) | undefined
): G {
  const withHome = (options: WorktreeOptions): WorktreeOptions => {
    const home = options.home ?? worktreeHome;
    if (home === undefined) {
      return options;
    }
    ensureDir?.(home);
    return { ...options, home };
  };
  const wrap = <W extends WorkspaceGit>(worktree: W) =>
    wrapGit(worktree, worktreeHome, context, ensureDir);
  const overrides: Partial<WorkspaceGit> = {
    withWorktree: (options, body) =>
      target.withWorktree(withHome(options), (worktree) => {
        const wrapped = wrap(worktree);
        const store = current.getStore();
        return store &&
          (context === undefined || store.bindings.context === context)
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

type Method = (...args: unknown[]) => Promise<unknown>;

function handle(
  root: string,
  loaded: () => Promise<PortableWorkspace>,
  gitOf: () => WorkspaceGit | undefined,
  worktreeHome: string | undefined,
  context: ExecutionContext | undefined,
  ensureDir: ((path: string) => void) | undefined
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
      return wrapGit(found, worktreeHome, context, ensureDir);
    },
  });
  return target as unknown as WorkspaceHandle;
}

export class WorkspacesManager implements ScopedWorkspaces {
  readonly #deps: WorkspacesDeps;
  readonly current: WorkspaceHandle;

  constructor(deps: WorkspacesDeps) {
    this.#deps = deps;
    let currentLoaded: Promise<PortableWorkspace> | undefined;
    this.current = handle(
      deps.root,
      () => {
        currentLoaded ??= this.#load(".");
        return currentLoaded;
      },
      () => deps.gitAt?.(deps.root),
      deps.worktreeHome,
      deps.context,
      deps.ensureDir
    );
  }

  get system(): WorkspaceCatalogue {
    if (this.#deps.catalogue === undefined) {
      throw new Error(
        "workspaces catalogue is not configured; provide options.workspaces"
      );
    }
    return this.#deps.catalogue;
  }

  get root(): string {
    return this.#deps.root;
  }

  #load(path: string): Promise<PortableWorkspace> {
    return this.system.load({
      path: resolveWorkspacePath(this.#deps.root, path),
    });
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
        this.#deps.context,
        this.#deps.ensureDir
      ),
      { id: workspace.id, source: workspace.source }
    );
  }

  scoped(_args?: ManagerArgs): ScopedWorkspaces {
    return { current: this.current, load: (ref) => this.load(ref) };
  }

  async close(): Promise<void> {
    await this.#deps.catalogue?.closeAll();
  }
}
