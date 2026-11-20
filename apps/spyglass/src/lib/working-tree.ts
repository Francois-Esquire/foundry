import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { hasErrorCode } from "@foundry/lib/atomic-file";
import { CHILD_CWD } from "./worker-runtime";

const NOT_A_REPOSITORY = /not a git repository/i;
const RENAMED_OR_COPIED = /^[RC]|^.[RC]/;

export type WorkingTree =
  | { kind: "git-missing" }
  | { kind: "not-a-repository" }
  | { kind: "failed"; message: string }
  | { kind: "repository"; dirty: string[] };

function porcelainPaths(output: string): string[] {
  const paths: string[] = [];
  let source = false;
  for (const entry of output.split("\0")) {
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

export function workingTree(root: string): WorkingTree {
  const run = (args: string[]) =>
    execFileSync("git", ["-C", resolve(root), ...args], {
      cwd: CHILD_CWD,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  let top: string;
  try {
    top = realpathSync(run(["rev-parse", "--show-toplevel"]).trim());
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") && existsSync(root)) {
      return { kind: "git-missing" };
    }
    const message = gitMessage(error);
    return NOT_A_REPOSITORY.test(message) || !existsSync(root)
      ? { kind: "not-a-repository" }
      : { kind: "failed", message };
  }
  try {
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
