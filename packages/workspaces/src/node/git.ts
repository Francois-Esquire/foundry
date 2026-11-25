import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { byCodeUnit } from "@foundry/lib/ordering";
import { errorCode } from "../errors";
import type { GitPathStatus, GitSnapshot, WorkspaceExtension } from "../types";

export type { GitPathStatus, GitSnapshot } from "../types";

const WORKTREE_PREFIX_PATTERN = /^worktree /;
const BRANCH_PREFIX_PATTERN = /^branch refs\/heads\//;
const BRANCH_HEAD_PREFIX = "# branch.head ";
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export type GitRun = (cwd: string, args: readonly string[]) => Promise<string>;

export interface GitOptions {
  readonly run?: GitRun;
}

export interface WorktreeOptions {
  readonly base: string;
  readonly branch?: string;
  readonly home?: string;
}

class GitExecError extends Error {
  readonly code: string | undefined;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    message: string,
    options: {
      readonly cause: unknown;
      readonly code?: string;
      readonly exitCode: number | null;
      readonly stderr: string;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = "GitExecError";
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.stderr = options.stderr;
  }
}

const REPOSITORY_LOCATION_VARIABLES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
]);

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !REPOSITORY_LOCATION_VARIABLES.has(name)
      )
    ),
    LC_ALL: "C",
  };
}

function execGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        env: gitEnv(),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const errno = typeof error.code === "string" ? error.code : undefined;
        const exitCode = typeof error.code === "number" ? error.code : null;
        reject(
          new GitExecError(stderr.trim() || error.message, {
            cause: error,
            ...(errno === undefined ? {} : { code: errno }),
            exitCode,
            stderr,
          })
        );
      }
    );
  });
}

const cut = new WeakSet<Worktree>();

export class Git {
  readonly root: string;
  protected readonly run: GitRun;

  protected constructor(root: string, options: GitOptions) {
    this.root = root;
    this.run = options.run ?? execGit;
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
      const output = await execGit(root, [
        "rev-parse",
        "--is-inside-work-tree",
      ]);
      return output.trim() === "true";
    } catch {
      return false;
    }
  }

  async status(): Promise<GitSnapshot> {
    let toplevel: string;
    try {
      const output = await execGit(this.root, [
        "rev-parse",
        "--is-inside-work-tree",
        "--show-toplevel",
      ]);
      const [inside, rootLine] = output.trim().split("\n");
      if (inside !== "true" || !rootLine) {
        return { kind: "none" };
      }
      toplevel = rootLine;
    } catch (error) {
      return (await isOutsideRepository(this.root, error))
        ? { kind: "none" }
        : unavailable(error);
    }

    try {
      const [repositoryRoot, workspaceRoot, porcelain] = await Promise.all([
        realpath(toplevel),
        realpath(this.root),
        execGit(this.root, [
          "status",
          "--porcelain=v2",
          "-z",
          "--branch",
          "--untracked-files=all",
        ]),
      ]);
      const parsed = parsePorcelainV2Status(porcelain);
      return {
        branch: parsed.detached ? null : parsed.branch,
        detached: parsed.detached,
        kind: "repository",
        paths: confine(repositoryRoot, workspaceRoot, parsed.files),
      };
    } catch (error) {
      return unavailable(error);
    }
  }

  async hasBranch(name: string): Promise<boolean> {
    try {
      await execGit(this.root, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${name}`,
      ]);
      return true;
    } catch (error) {
      if (error instanceof GitExecError && error.exitCode === 1) {
        return false;
      }
      throw error;
    }
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

export interface GitCapabilities {
  readonly git: Git;
}

export function git(
  options: GitOptions = {}
): WorkspaceExtension<never, unknown, Partial<GitCapabilities>> {
  return {
    applies: (registration) => Git.isRepository(registration.source.path),
    attach: ({ registration }) => ({
      capabilities: { git: Git.at(registration.source.path, options) },
    }),
    name: "git",
  };
}

async function isOutsideRepository(
  root: string,
  error: unknown
): Promise<boolean> {
  if (!(error instanceof GitExecError)) {
    return false;
  }
  if (error.code === "ENOTDIR") {
    return true;
  }
  if (error.code === "ENOENT") {
    return !(await directoryExists(root));
  }
  const stderr = error.stderr.toLowerCase();
  return (
    stderr.includes("not a git repository") ||
    stderr.includes("must be run in a work tree")
  );
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

interface ParsedPorcelainStatus {
  readonly branch: string | null;
  readonly detached: boolean;
  readonly files: readonly RawFileStatus[];
}

function afterSpaces(line: string, count: number): string | undefined {
  let cursor = 0;
  for (let seen = 0; seen < count; seen += 1) {
    const space = line.indexOf(" ", cursor);
    if (space === -1) {
      return;
    }
    cursor = space + 1;
  }
  return line.slice(cursor);
}

const PORCELAIN_PATH_SPACES: Readonly<Record<string, number>> = {
  "1": 8,
  "2": 9,
  u: 10,
};

function parsePorcelainV2Entry(
  token: string,
  nextToken: string | undefined
):
  | { readonly consumedNext: boolean; readonly file: RawFileStatus }
  | undefined {
  if (token.startsWith("? ")) {
    return {
      consumedNext: false,
      file: { index: "?", path: token.slice(2), worktree: "?" },
    };
  }
  const [kind] = token;
  const spaces = kind === undefined ? undefined : PORCELAIN_PATH_SPACES[kind];
  const path = spaces === undefined ? undefined : afterSpaces(token, spaces);
  if (path === undefined) {
    return;
  }
  const consumedNext = kind === "2";
  return {
    consumedNext,
    file: {
      from: consumedNext ? nextToken : undefined,
      index: token[2] ?? ".",
      path,
      worktree: token[3] ?? ".",
    },
  };
}

function parsePorcelainV2Status(output: string): ParsedPorcelainStatus {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") {
    tokens.pop();
  }
  let branch: string | null = null;
  let detached = false;
  const files: RawFileStatus[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token.startsWith(BRANCH_HEAD_PREFIX)) {
      const head = token.slice(BRANCH_HEAD_PREFIX.length);
      detached = head === "(detached)";
      branch = detached ? null : head;
      continue;
    }
    if (token.startsWith("# ")) {
      continue;
    }
    const parsed = parsePorcelainV2Entry(token, tokens[index + 1]);
    if (!parsed) {
      continue;
    }
    files.push(parsed.file);
    if (parsed.consumedNext) {
      index += 1;
    }
  }

  return { branch, detached, files };
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
  readonly worktree: string;
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
    const unstaged = isChanged(file.worktree);
    record(file.path, {
      staged,
      unstaged,
      untracked: file.index === "?" && file.worktree === "?",
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
  return column !== "." && column !== " " && column !== "?" && column !== "";
}
