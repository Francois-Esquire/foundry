import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { hasErrorCode } from "@foundry/lib/atomic-file";

/** Git's own word for a directory outside any repository. */
const NOT_A_REPOSITORY = /not a git repository/i;
/** A porcelain status whose entry is followed by the path it was renamed or copied from. */
const RENAMED_OR_COPIED = /^[RC]|^.[RC]/;

/**
 * What Git says of a workspace's working tree: whether Git is installed,
 * whether the workspace is in a repository, and, when it is, every dirty
 * file (untracked ones included) relative to the workspace root. `failed`:
 * Git ran in a repository and could not read it, such as for dubious
 * ownership or a held `index.lock`, with Git's own message.
 */
export type WorkingTree =
  | { kind: "git-missing" }
  | { kind: "not-a-repository" }
  | { kind: "failed"; message: string }
  | { kind: "repository"; dirty: string[] };

/**
 * The paths `git status --porcelain -z` lists, each as Git wrote it: no
 * quoting, so spaces, quotes, and non-ASCII names come through whole. A
 * rename or copy is `XY new\0old\0`; the new path is kept.
 */
function porcelainPaths(output: string): string[] {
  const paths: string[] = [];
  let source = false;
  for (const entry of output.split("\0")) {
    // The token after a rename or copy is the path it came from.
    if (source) {
      source = false;
      continue;
    }
    if (entry.length > 3) {
      paths.push(entry.slice(3));
      source = RENAMED_OR_COPIED.test(entry.slice(0, 2));
    }
  }
  return paths;
}

/** Git's message for a failed command, or the error's own. */
function gitMessage(error: unknown): string {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr).trim()
      : "";
  if (stderr !== "") {
    return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The working tree of the workspace at `root`; reads only. */
export function workingTree(root: string): WorkingTree {
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  let top: string;
  try {
    top = realpathSync(run(["rev-parse", "--show-toplevel"]).trim());
  } catch (error) {
    // A missing directory fails to spawn with ENOENT too.
    if (hasErrorCode(error, "ENOENT") && existsSync(root)) {
      return { kind: "git-missing" };
    }
    const message = gitMessage(error);
    return NOT_A_REPOSITORY.test(message) || !existsSync(root)
      ? { kind: "not-a-repository" }
      : { kind: "failed", message };
  }
  try {
    // Porcelain paths are relative to the repository, so they are re-based.
    const base = realpathSync(root);
    const dirty = porcelainPaths(
      run(["status", "--porcelain", "-z", "--untracked-files=all"])
    )
      .map((file) => relative(base, join(top, file)).split(sep).join("/"))
      .filter((file) => !file.startsWith("../"));
    return { dirty, kind: "repository" };
  } catch (error) {
    return { kind: "failed", message: gitMessage(error) };
  }
}
