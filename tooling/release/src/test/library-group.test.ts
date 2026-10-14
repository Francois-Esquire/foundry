import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Commit, GitHub, Manifest, type Strategy } from "release-please";
import { parseConventionalCommits } from "release-please/build/src/commit";
import { buildStrategy } from "release-please/build/src/factory";
import type { CandidateReleasePullRequest } from "release-please/build/src/manifest";
import type { Release } from "release-please/build/src/release";
import { TagName } from "release-please/build/src/util/tag-name";
import { Version } from "release-please/build/src/version";
import { configureLibraryGroup, libraryGroup } from "../library-group";
import { discoverWorkspaces, type Workspace } from "../release";
import { WorkspacePlugin } from "../workspace-plugin";

function library(
  name: string,
  privatePackage = true,
  version = "0.1.0"
): Workspace {
  return {
    directory: `packages/${name}`,
    manifest: { name: `@foundry/${name}`, private: privatePackage, version },
  };
}

test("private libraries stay dormant; public libraries use their package manifests", async () => {
  const github = await GitHub.create({
    defaultBranch: "main",
    owner: "test",
    repo: "test",
  });
  const manifest = new Manifest(
    github,
    "main",
    {
      "apps/marbles": { component: "marbles", releaseType: "node" },
      "apps/spyglass": { component: "spyglass", releaseType: "node" },
    },
    {}
  );
  configureLibraryGroup(manifest, [library("core"), library("lib")]);
  expect(Object.keys(manifest.repositoryConfig).sort()).toEqual([
    "apps/marbles",
    "apps/spyglass",
  ]);
  configureLibraryGroup(manifest, [library("core", false), library("lib")]);
  expect(manifest.repositoryConfig["packages/core"]).toMatchObject({
    component: "core",
    releaseType: "node",
  });
  expect(manifest.repositoryConfig["packages/lib"]).toBeUndefined();
  expect(() =>
    libraryGroup([library("core"), library("lib", false, "0.2.0")])
  ).toThrow("same version");
  expect(
    libraryGroup(
      discoverWorkspaces(resolve(import.meta.dirname, "../../../.."))
    ).publicPackages
  ).toEqual([]);
});

test("linked versions produce one library PR, preserve privacy and leave app versions independent", async () => {
  const root = mkdtempSync(join(tmpdir(), "library-release-"));
  const github = await GitHub.create({
    defaultBranch: "main",
    owner: "test",
    repo: "test",
  });
  const reader = spyOn(github, "getFileContentsOnBranch").mockImplementation(
    async (path) => {
      const parsedContent = readFileSync(join(root, path), "utf8");
      return {
        content: Buffer.from(parsedContent).toString("base64"),
        mode: "100644",
        parsedContent,
        sha: "a".repeat(40),
      };
    }
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        private: true,
        workspaces: ["packages/*", "apps/*"],
      })
    );
    const dependent = library("models", false);
    dependent.manifest.dependencies = { "@foundry/core": "workspace:*" };
    const workspaces: Workspace[] = [
      library("core", false),
      dependent,
      library("lib"),
      {
        directory: "apps/marbles",
        manifest: {
          name: "@foundry.sh/marbles",
          private: false,
          version: "0.0.7",
        },
      },
      {
        directory: "apps/spyglass",
        manifest: {
          name: "@foundry/spyglass",
          private: false,
          version: "2.3.0",
        },
      },
    ];
    for (const workspace of workspaces) {
      mkdirSync(join(root, workspace.directory), { recursive: true });
      writeFileSync(
        join(root, workspace.directory, "package.json"),
        JSON.stringify(workspace.manifest)
      );
    }
    execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
      cwd: root,
      stdio: "pipe",
    });
    git("init", "--quiet");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("add", ".");
    git("commit", "-qm", "chore: release libraries");
    const previous = git("rev-parse", "HEAD");
    writeFileSync(join(root, "packages/core/feature.ts"), "export {};\n");
    git("add", ".");
    git("commit", "-qm", "feat: improve core");
    const manifest = new Manifest(github, "main", {}, {});
    configureLibraryGroup(manifest, workspaces);
    const plugin = new WorkspacePlugin(
      github,
      "main",
      manifest.repositoryConfig,
      root
    );
    const strategies: Record<string, Strategy> = {};
    const releases: Record<string, Release> = {};
    const commits: Record<string, Commit[]> = {};
    for (const [path, config] of Object.entries(manifest.repositoryConfig)) {
      strategies[path] = await buildStrategy({
        ...config,
        github,
        path,
        targetBranch: "main",
      });
      releases[path] = {
        notes: "previous",
        sha: previous,
        tag: new TagName(Version.parse("0.1.0"), config.component),
      };
    }
    const linked = await plugin.preconfigure(strategies, commits, releases);
    const candidates: CandidateReleasePullRequest[] = [];
    for (const [path, strategy] of Object.entries(linked)) {
      const proposal = await strategy.buildReleasePullRequest(
        parseConventionalCommits(commits[path] ?? []),
        releases[path]
      );
      const config = manifest.repositoryConfig[path];
      if (!(proposal && config)) {
        throw new Error("Expected library proposal");
      }
      expect(proposal.version?.toString()).toBe("0.2.0");
      candidates.push({ config, path, pullRequest: proposal });
    }
    const merged = await plugin.run(candidates);
    expect(merged).toHaveLength(1);
    const updates = merged[0]?.pullRequest.updates ?? [];
    expect(
      merged[0]?.pullRequest.body.releaseData
        .map(({ component }) => component)
        .sort()
    ).toEqual(["core", "models"]);
    for (const workspace of workspaces) {
      const path = `${workspace.directory}/package.json`;
      const original = readFileSync(join(root, path), "utf8");
      const update = updates.find((entry) => entry.path === path);
      if (workspace.directory.startsWith("apps/")) {
        expect(update).toBeUndefined();
      } else {
        expect(
          JSON.parse(update?.updater.updateContent(original) ?? "{}")
        ).toEqual({ ...workspace.manifest, version: "0.2.0" });
      }
      expect(JSON.parse(readFileSync(join(root, path), "utf8"))).toEqual(
        workspace.manifest
      );
    }
    expect(updates.some(({ path }) => path === "bun.lock")).toBe(true);
  } finally {
    reader.mockRestore();
    rmSync(root, { force: true, recursive: true });
  }
});
