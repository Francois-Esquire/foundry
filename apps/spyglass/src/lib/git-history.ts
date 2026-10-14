import { execFile } from "node:child_process";
import { promisify } from "node:util";

const tokenPattern = /^\n/;

const run = promisify(execFile);

// Git history collector: one repository-wide `git log` turned into a
// normalized commit → files model. Read-only, no network, no per-file log.
// Paths are root-relative posix (Git's own form). Timestamps are committer
// dates — when a change landed in this history, which is also what
// `--since` filters on.

interface CommitFileChange {
  /** null for binary changes (Git reports no line counts). */
  additions: number | null;
  deletions: number | null;
  path: string;
  /** Present when Git detected a rename; `path` is the new name. */
  previousPath?: string;
}

export interface CommitChange {
  /** Author name after .mailmap; never an email address. */
  author: string;
  files: CommitFileChange[];
  hash: string;
  /** Committer date, ISO-8601. */
  timestamp: string;
}

type GitHistoryUnavailableReason =
  | "git-unavailable"
  | "not-git-repository"
  /** The analysis profile chose not to read Git (V12.3 temporal checkpoints). */
  | "not-collected";

export interface GitHistoryOptions {
  /** Clock for `analyzedAt`; defaults to the wall clock. */
  now?: Date;
}

export type GitHistory =
  | {
      available: true;
      root: string;
      analyzedAt: string;
      /** True when the clone is shallow: counts describe partial history. */
      shallow: boolean;
      /** Newest first, full history of the root. */
      commits: CommitChange[];
      /** Every path Git currently tracks under the root. */
      trackedFiles: string[];
    }
  | {
      available: false;
      root: string;
      analyzedAt: string;
      reason: GitHistoryUnavailableReason;
    };

/** Large repositories exceed Node's 1 MB default (this one logs ~2 MB). */
const MAX_BUFFER = 2 ** 28;

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.*)$/s;

function count(value: string): number | null {
  return value === "-" ? null : Number(value);
}

/**
 * Parse `git log -z --numstat --format=%x01%H%x00%cI%x00%aN`. Each commit is
 * `\x01hash\0date\0author\0\n` followed by NUL-terminated numstat records;
 * a rename record has an empty path and is followed by the old and new
 * paths as two more NUL-terminated tokens.
 */
export function parseGitLog(output: string): CommitChange[] {
  const commits: CommitChange[] = [];
  for (const chunk of output.split("\x01").slice(1)) {
    const tokens = chunk.split("\0");
    const [hash, timestamp, author] = tokens;
    if (hash === undefined || timestamp === undefined || author === undefined) {
      continue;
    }
    const files: CommitFileChange[] = [];
    let index = 3;
    while (index < tokens.length) {
      const token = tokens[index]?.replace(tokenPattern, "") ?? "";
      index += 1;
      const match = NUMSTAT.exec(token);
      if (match === null) {
        continue;
      }
      const [, additions, deletions, inlinePath] = match;
      if (inlinePath !== "") {
        files.push({
          additions: count(additions ?? "-"),
          deletions: count(deletions ?? "-"),
          path: inlinePath ?? "",
        });
        continue;
      }
      const previousPath = tokens[index] ?? "";
      const path = tokens[index + 1] ?? "";
      index += 2;
      files.push({
        additions: count(additions ?? "-"),
        deletions: count(deletions ?? "-"),
        path,
        previousPath,
      });
    }
    commits.push({ author, files, hash, timestamp });
  }
  return commits;
}

/**
 * Collect the full commit history of `root` (paths relative to it). Renames
 * are detected by Git's similarity heuristic within the root only; a file
 * moved in from outside the root appears as an addition.
 */
export async function collectGitHistory(
  root: string,
  options: GitHistoryOptions = {}
): Promise<GitHistory> {
  const analyzedAt = (options.now ?? new Date()).toISOString();
  let insideRepository: string;
  try {
    insideRepository = (
      await git(root, ["rev-parse", "--is-inside-work-tree"])
    ).trim();
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    return {
      analyzedAt,
      available: false,
      reason: code === "ENOENT" ? "git-unavailable" : "not-git-repository",
      root,
    };
  }
  if (insideRepository !== "true") {
    return { analyzedAt, available: false, reason: "not-git-repository", root };
  }
  const [shallow, log, tracked] = await Promise.all([
    git(root, ["rev-parse", "--is-shallow-repository"]),
    git(root, [
      "log",
      "-z",
      "--numstat",
      "-M",
      "--relative",
      "--format=%x01%H%x00%cI%x00%aN",
      "--",
      ".",
    ]).catch(() => ""), // a repository with no commits yet
    git(root, ["ls-files", "-z"]),
  ]);
  return {
    analyzedAt,
    available: true,
    commits: parseGitLog(log),
    root,
    shallow: shallow.trim() === "true",
    trackedFiles: tracked.split("\0").filter((file) => file !== ""),
  };
}
