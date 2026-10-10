import { execFileSync } from "node:child_process";

/** Makes the directory a Git repository with everything in it committed once. */
export function commitFixture(root: string): void {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-q"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Atlas fixture",
    "-c",
    "user.email=atlas@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Initial fixture",
  ]);
}
