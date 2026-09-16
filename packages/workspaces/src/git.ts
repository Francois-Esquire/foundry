const WORKTREE_PREFIX_PATTERN = /^worktree /;
const BRANCH_PREFIX_PATTERN = /^branch refs\/heads\//;

import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import simpleGit from "simple-git";

import type { WorkspaceExtension } from "./extension";
import type { WorkspaceCtor } from "./instance";

import { byCodeUnit } from "./ordering";

/**
 * Git over one working tree.
 *
 * Opt-in: nothing on the root export touches this file beyond its types. A
 * `Git` is rooted at a path and answers for that root alone; a `Worktree` is
 * a `Git` whose root was checked out from another one. `WithGit` is the
 * Workspace layer that carries one. Git never decides which Files enter the
 * catalog; `.gitignore` informs the scanner, and that is a separate authority.
 */

/**
 * One changed path, as the working tree sees it.
 *
 * The three flags are independent on purpose: a file edited after it was
 * staged is genuinely both, and collapsing that here would make presentation
 * guess. Whoever renders decides precedence.
 */
export interface GitPathStatus {
  /** Normalized POSIX path relative to the Workspace root. */
  readonly path: string;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
}

/**
 * What one status read found.
 *
 * `none` is not a failure — an ordinary directory simply has no Git
 * capability, and the Workspace is complete without one.
 */
export type GitSnapshot =
  | { readonly kind: "none" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "repository";
      /** Null on a detached HEAD, where there is no branch to name. */
      readonly branch: string | null;
      readonly detached: boolean;
      readonly paths: readonly GitPathStatus[];
    };

/**
 * Runs one git command in `cwd` and returns its stdout. Every mutation goes
 * through it, so a host can echo instead of run. Status does not: it is
 * parsed by `simple-git`, and a fake runner has nothing to say to it.
 */
export type GitRun = (cwd: string, args: readonly string[]) => Promise<string>;

export interface GitOptions {
  readonly run?: GitRun;
}

export interface WorktreeOptions {
  /** Commit-ish to check out. */
  readonly base: string;
  /** Branch to create at `base`; detached HEAD when omitted. */
  readonly branch?: string;
  /**
   * Where the checkout lands. Defaults to the OS temp dir: anything under a
   * work tree shows up as untracked in every other agent's status, which is
   * exactly the interference a worktree is for avoiding.
   */
  readonly home?: string;
}

const runWithSimpleGit: GitRun = (cwd, args) => simpleGit(cwd).raw([...args]);

export class Git {
  readonly root: string;
  protected readonly run: GitRun;

  protected constructor(root: string, options: GitOptions) {
    this.root = root;
    this.run = options.run ?? runWithSimpleGit;
  }

  /** Unchecked: the root may not be a repository, and `status()` will say so. */
  static at(root: string, options: GitOptions = {}): Git {
    return new Git(root, options);
  }

  /** A `Git` when the root is inside a working tree; null otherwise. */
  static async open(
    root: string,
    options: GitOptions = {}
  ): Promise<Git | null> {
    if (!(await Git.isRepository(root))) {
      return null;
    }
    return new Git(root, options);
  }

  /**
   * False for anything that is not a directory inside a working tree — an
   * ordinary directory, a resource URI, a repository Git cannot open.
   * `status()` is the call that tells the last two apart.
   */
  static async isRepository(root: string): Promise<boolean> {
    try {
      return await simpleGit(root).checkIsRepo();
    } catch {
      return false;
    }
  }

  /** The working tree as it stands: one detached read, nothing kept. */
  async status(): Promise<GitSnapshot> {
    let client: ReturnType<typeof simpleGit>;
    try {
      client = simpleGit(this.root);
    } catch {
      // The directory is gone or unreadable. That is the Workspace source's
      // problem to report, not a Git failure over a Workspace that has none.
      return { kind: "none" };
    }

    try {
      // Resolving false is an answer: this is simply not a working tree.
      // Throwing is not — a missing `client` binary or a `.client` that cannot be
      // read is operational trouble, and reporting it as an ordinary directory
      // would hide a broken environment behind a Workspace that looks fine.
      if (!(await client.checkIsRepo())) {
        return { kind: "none" };
      }
    } catch (error) {
      return unavailable(error);
    }

    try {
      // Both sides are resolved before they are compared. Git answers with the
      // real path, while a caller's root may still be spelled through a symlink
      // — on macOS every `$TMPDIR` path is — and the two would share no prefix.
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

  /** The linked worktrees of this repository, as `client worktree list` reports them. */
  async worktrees(): Promise<readonly Worktree[]> {
    const listing = await this.run(this.root, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    // The main working tree is always the first block and is this `Git`, not
    // a worktree of it.
    return parseWorktreeList(listing)
      .slice(1)
      .map(
        (entry) =>
          new Worktree(entry.root, this.root, entry.branch, { run: this.run })
      );
  }

  /** Check `base` out into a fresh directory. */
  async worktree(options: WorktreeOptions): Promise<Worktree> {
    // Resolved so the root matches what `worktrees()` reads back from git,
    // which reports real paths; on macOS every `$TMPDIR` path is a symlink.
    const root = await realpath(
      await mkdtemp(join(options.home ?? tmpdir(), "worktree-"))
    );
    await this.run(this.root, [
      "worktree",
      "add",
      ...(options.branch === undefined ? ["--detach"] : ["-b", options.branch]),
      root,
      options.base,
    ]);
    return new Worktree(root, this.root, options.branch ?? null, {
      run: this.run,
    });
  }

  /** Run `body` in a worktree and remove it afterwards, however `body` ends. */
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
  /** Root of the repository this was cut from; `git worktree remove` runs there. */
  readonly repository: string;
  /** Null on a detached HEAD. */
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
  }
}

/**
 * The Workspace layer that carries a `Git` rooted at `source.path`. It adds
 * a capability and answers no source primitive, so it composes over any
 * layer whose path is a working tree.
 */
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

/**
 * The git layer as an extension: applies when the record's path is a working
 * tree. It applies per record, so on a system-opened Workspace `git` is
 * optional; `WithGit` composed by hand carries it for certain.
 */
export function git(
  options: GitOptions = {}
): WorkspaceExtension<never, unknown, Partial<GitCapable>> {
  return {
    applies: (record) => Git.isRepository(record.path),
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

/**
 * A Git failure is supplementary: it never becomes the Workspace's own state,
 * and its text never carries the absolute root.
 */
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

/**
 * Repository-relative status paths become Workspace-relative ones, and
 * anything outside the Workspace root is dropped.
 *
 * A Workspace nested inside a larger repository is the normal case, and Git
 * reports the whole working tree. Publishing a sibling directory's changes
 * would leak paths the Workspace has no business naming.
 */
function confine(
  repositoryRoot: string,
  workspaceRoot: string,
  files: readonly RawFileStatus[]
): readonly GitPathStatus[] {
  const nested = relative(repositoryRoot, workspaceRoot);
  // A Workspace reached through `--show-toplevel` is inside its own repository
  // by construction; an escaping prefix would mean neither path is what it
  // claimed, so nothing is published rather than something re-based wrongly.
  // Tested as a whole segment: a directory named `..leading` is an ordinary
  // name, and dropping its own changes would be a silent loss.
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
    // A rename reports its destination as the path and its origin as `from`.
    // A Workspace showing only the arrival would leave the departure looking
    // unchanged — but the origin takes the index column alone. It has no
    // working-tree entry of its own: for `RM` the `M` describes bytes edited
    // at the destination after the rename was staged, and copying it onto the
    // origin marks a path that no longer exists as having unstaged changes.
    record(file.from, { staged, unstaged: false, untracked: false });
  }
  // The same code-unit order the File catalog uses, so a status list and the
  // rows it annotates never mean two different things by "sorted".
  return [...byPath.values()].sort(byCodeUnit((entry) => entry.path));
}

/**
 * Null when the repository-relative path is not inside the Workspace.
 *
 * The path is taken exactly as Git gave it. A backslash is an ordinary
 * character in a POSIX filename, not a separator, and rewriting one would
 * annotate `a/b.md` while the catalog holds `a\b.md` — the mark silently
 * lands on nothing. The confinement check is a check, never a repair: a
 * result that is absolute or walks up is refused rather than corrected.
 *
 * Only two shapes are refused, and neither can name a legitimate relative
 * path. A drive-letter test belongs to neither list: Git porcelain reports
 * repository-relative paths on every platform and never a drive letter, while
 * `:` is a legal character in a POSIX filename — so such a test has no true
 * positives at all and would silently drop `C:notes.md`.
 */
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

/**
 * One status column. Anything but unmodified and untracked is a change, and
 * the index and working-tree columns are read the same way — which column was
 * asked is what makes the answer staged or unstaged.
 */
function isChanged(column: string): boolean {
  return column !== " " && column !== "?" && column !== "";
}

function errorCode(error: unknown): string {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    return code;
  }
  return error instanceof Error ? error.name : "unknown";
}
