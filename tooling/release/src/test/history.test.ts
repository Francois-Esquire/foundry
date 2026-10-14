import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledPaths, readReleaseCommits } from "../history";
import type { Workspace } from "../release";

test("bundled dev dependencies affect app releases without becoming publish dependencies", () => {
  const workspaces: Workspace[] = [
    {
      directory: "apps/marbles",
      manifest: {
        devDependencies: {
          "@foundry/agents": "workspace:*",
          "@foundry/tsconfig": "workspace:*",
        },
        name: "@foundry/marbles",
        version: "0.0.1",
      },
    },
    {
      directory: "packages/agents",
      manifest: {
        dependencies: { "@foundry/lib": "workspace:*" },
        name: "@foundry/agents",
        private: true,
        version: "0.1.0",
      },
    },
    {
      directory: "packages/lib",
      manifest: { name: "@foundry/lib", private: true, version: "0.1.0" },
    },
    {
      directory: "packages/unrelated",
      manifest: { name: "@foundry/unrelated", private: true, version: "0.1.0" },
    },
    {
      directory: "tooling/typescript",
      manifest: { name: "@foundry/tsconfig", private: true, version: "0.0.0" },
    },
  ];
  expect(bundledPaths("apps/marbles", workspaces)).toEqual([
    "apps/marbles",
    "packages/agents",
    "packages/lib",
  ]);
});

test("app change attribution uses its own release boundary and preserves breaking footers", () => {
  const root = mkdtempSync(join(tmpdir(), "release-history-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    git("config", "user.name", "Release test");
    git("config", "user.email", "release@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(root, "library.ts"), "before");
    git("add", ".");
    git("commit", "--quiet", "-m", "feat: initial library");
    const released = git("rev-parse", "HEAD");
    writeFileSync(join(root, "library.ts"), "after");
    git("add", ".");
    git(
      "commit",
      "--quiet",
      "-m",
      "feat(library)!: revise API\n\nBREAKING CHANGE: use the new name"
    );
    const change = git("rev-parse", "HEAD");
    writeFileSync(join(root, "other.ts"), "unrelated");
    git("add", ".");
    git("commit", "--quiet", "-m", "fix: unrelated app");
    const commits = readReleaseCommits(root, ["library.ts"], released);
    expect(commits.map(({ sha }) => sha)).toEqual([change]);
    expect(commits[0]?.message).toContain("BREAKING CHANGE: use the new name");
    expect(readReleaseCommits(root, ["library.ts"], change)).toEqual([]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
