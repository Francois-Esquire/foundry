import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A throwaway repository — never the checkout the suite runs in. */
export async function seedRepository(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "marbles-repo-"));
  const git = (...args: string[]) =>
    execFileAsync("git", ["-C", root, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.email", "marbles@example.test");
  await git("config", "user.name", "Marbles");
  writeFileSync(join(root, "README.md"), "seed\n");
  await git("add", "README.md");
  await git("commit", "-m", "seed");
  return root;
}
