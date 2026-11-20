import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { CHILD_CWD } from "./worker-runtime";

const tokenPattern = /^\n/;

const run = promisify(execFile);

interface CommitFileChange {
  additions: number | null;
  deletions: number | null;
  path: string;
  previousPath?: string;
}

export interface CommitChange {
  author: string;
  files: CommitFileChange[];
  hash: string;
  timestamp: string;
}

type GitHistoryUnavailableReason =
  | "git-unavailable"
  | "not-git-repository"
  | "not-collected";

export interface GitHistoryOptions {
  now?: Date;
}

export type GitHistory =
  | {
      available: true;
      root: string;
      analyzedAt: string;
      shallow: boolean;
      commits: CommitChange[];
      trackedFiles: string[];
    }
  | {
      available: false;
      root: string;
      analyzedAt: string;
      reason: GitHistoryUnavailableReason;
    };

const MAX_BUFFER = 2 ** 28;

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", resolve(root), ...args], {
    cwd: CHILD_CWD,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.*)$/s;

function count(value: string): number | null {
  return value === "-" ? null : Number(value);
}

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
    ]).catch(() => ""),
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
