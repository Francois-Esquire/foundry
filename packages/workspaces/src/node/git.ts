import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { byCodeUnit } from "@foundry/lib/ordering";
import simpleGit from "simple-git";
import { errorCode } from "../errors";
import type { WorkspaceCtor, WorkspaceExtension } from "../types";

const WORKTREE_PREFIX_PATTERN = /^worktree /;
const BRANCH_PREFIX_PATTERN = /^branch refs\/heads\//;

export interface GitPathStatus {
  readonly path: string;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
}

export type GitSnapshot =
  | { readonly kind: "none" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "repository";
      readonly branch: string | null;
      readonly detached: boolean;
      readonly paths: readonly GitPathStatus[];
    };

export type GitRun = (cwd: string, args: readonly string[]) => Promise<string>;

export interface GitOptions {
  readonly run?: GitRun;
}

export interface WorktreeOptions {
  readonly base: string;
  readonly branch?: string;
  readonly home?: string;
}

const runWithSimpleGit: GitRun = (cwd, args) => simpleGit(cwd).raw([...args]);

const cut = new WeakSet<Worktree>();

export class Git {
  readonly root: string;
  protected readonly run: GitRun;

  protected constructor(root: string, options: GitOptions) {
    this.root = root;
    this.run = options.run ?? runWithSimpleGit;
  }

  static at(root: string, options: GitOptions = {}): Git {
    return new Git(root, options);
  }

  static async open(
    root: string,
    options: GitOptions = {}
  ): Promise<Git | null> {
    if (!(await Git.isRepository(root))) {
      return null;
    }
    return new Git(root, options);
  }

  static async isRepository(root: string): Promise<boolean> {
    try {
      return await simpleGit(root).checkIsRepo();
    } catch {
      return false;
    }
  }

  async status(): Promise<GitSnapshot> {
    let client: ReturnType<typeof simpleGit>;
    try {
      client = simpleGit(this.root);
    } catch {
      return { kind: "none" };
    }

    try {
      if (!(await client.checkIsRepo())) {
        return { kind: "none" };
      }
    } catch (error) {
      return unavailable(error);
    }

    try {
      const repositoryRoot = await realpath(
        (await client.revparse(["--show-toplevel"])).trim()
      );
      const workspaceRoot = await realpath(this.root);
      const status = await client.status();
      return {
        branch: status.detached ? null : status.current,
        detached: status.detached,
        kind: "repository",
        paths: confine(repositoryRoot, workspaceRoot, status.files),
      };
    } catch (error) {
      return unavailable(error);
    }
  }

  async hasBranch(name: string): Promise<boolean> {
    const branches = await simpleGit(this.root).branchLocal();
    return branches.all.includes(name);
  }

  async worktrees(): Promise<readonly Worktree[]> {
    const listing = await this.run(this.root, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    return parseWorktreeList(listing)
      .slice(1)
      .map(
        (entry) =>
          new Worktree(entry.root, this.root, entry.branch, { run: this.run })
      );
  }

  async worktree(options: WorktreeOptions): Promise<Worktree> {
    if (
      options.branch !== undefined &&
      (await this.hasBranch(options.branch))
    ) {
      throw new Error(
        `branch "${options.branch}" already exists; pass a new branch, or check it out with worktree({ base: "${options.branch}" })`
      );
    }
    const root = await realpath(
      await mkdtemp(join(options.home ?? tmpdir(), "worktree-"))
    );
    try {
      await this.run(this.root, [
        "worktree",
        "add",
        ...(options.branch === undefined
          ? ["--detach"]
          : ["-b", options.branch]),
        "--",
        root,
        options.base,
      ]);
    } catch (error) {
      await rm(root, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
    const worktree = new Worktree(root, this.root, options.branch ?? null, {
      run: this.run,
    });
    cut.add(worktree);
    return worktree;
  }

  async withWorktree<T>(
    options: WorktreeOptions,
    body: (worktree: Worktree) => Promise<T>
  ): Promise<T> {
    const worktree = await this.worktree(options);
    try {
      return await body(worktree);
    } finally {
      await worktree.remove();
    }
  }
}

export class Worktree extends Git {
  readonly repository: string;
  readonly branch: string | null;

  constructor(
    root: string,
    repository: string,
    branch: string | null,
    options: GitOptions
  ) {
    super(root, options);
    this.repository = repository;
    this.branch = branch;
  }

  async remove(): Promise<void> {
    await this.run(this.repository, [
      "worktree",
      "remove",
      "--force",
      this.root,
    ]);
    if (cut.has(this)) {
      await rm(this.root, { force: true, recursive: true });
    }
  }
}

export function WithGit<B extends WorkspaceCtor>(
  Base: B,
  options: GitOptions = {}
): B & WorkspaceCtor<GitCapable> {
  return class extends Base implements GitCapable {
    readonly git: Git = Git.at(this.source.path, options);
  };
}

export interface GitCapable {
  readonly git: Git;
}

export function git(
  options: GitOptions = {}
): WorkspaceExtension<never, unknown, Partial<GitCapable>> {
  return {
    applies: (registration) => Git.isRepository(registration.source.path),
    name: "git",
    wrap: (Base) => WithGit(Base, options),
  };
}

function parseWorktreeList(
  listing: string
): readonly { root: string; branch: string | null }[] {
  return listing
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block) => {
      const lines = block.split("\n");
      const root = lines[0]?.replace(WORKTREE_PREFIX_PATTERN, "") ?? "";
      const branchLine = lines.find((line) => line.startsWith("branch "));
      const branch = branchLine?.replace(BRANCH_PREFIX_PATTERN, "") ?? null;
      return { branch, root };
    });
}

function unavailable(error: unknown): GitSnapshot {
  return {
    kind: "unavailable",
    reason: `Could not read Git state (${errorCode(error)})`,
  };
}

interface RawFileStatus {
  readonly from?: string | undefined;
  readonly index: string;
  readonly path: string;
  readonly working_dir: string;
}

function confine(
  repositoryRoot: string,
  workspaceRoot: string,
  files: readonly RawFileStatus[]
): readonly GitPathStatus[] {
  const nested = relative(repositoryRoot, workspaceRoot);
  if (nested === ".." || nested.startsWith(`..${sep}`)) {
    return [];
  }
  const prefix = nested === "" ? "" : `${nested.split(sep).join("/")}/`;

  const byPath = new Map<string, GitPathStatus>();
  const record = (candidate: string, status: Omit<GitPathStatus, "path">) => {
    const within = strip(prefix, candidate);
    if (within === null) {
      return;
    }
    const existing = byPath.get(within);
    byPath.set(within, {
      path: within,
      staged: status.staged || existing?.staged === true,
      unstaged: status.unstaged || existing?.unstaged === true,
      untracked: status.untracked || existing?.untracked === true,
    });
  };

  for (const file of files) {
    const staged = isChanged(file.index);
    const unstaged = isChanged(file.working_dir);
    record(file.path, {
      staged,
      unstaged,
      untracked: file.index === "?" && file.working_dir === "?",
    });
    if (file.from === undefined) {
      continue;
    }
    record(file.from, { staged, unstaged: false, untracked: false });
  }
  return [...byPath.values()].sort(byCodeUnit((entry) => entry.path));
}

function strip(prefix: string, path: string): string | null {
  if (prefix !== "" && !path.startsWith(prefix)) {
    return null;
  }
  const within = prefix === "" ? path : path.slice(prefix.length);
  if (within === "" || within.startsWith("/")) {
    return null;
  }
  return within.split("/").includes("..") ? null : within;
}

function isChanged(column: string): boolean {
  return column !== " " && column !== "?" && column !== "";
}
