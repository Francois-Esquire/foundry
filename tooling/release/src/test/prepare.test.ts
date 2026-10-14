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
import { GitHub, Manifest } from "release-please";
import { parseConventionalCommits } from "release-please/build/src/commit";
import { buildStrategy } from "release-please/build/src/factory";
import type { CandidateReleasePullRequest } from "release-please/build/src/manifest";
import { ReleasePleaseManifest } from "release-please/build/src/updaters/release-please-manifest";
import { PullRequestBody } from "release-please/build/src/util/pull-request-body";
import { PullRequestTitle } from "release-please/build/src/util/pull-request-title";
import { TagName } from "release-please/build/src/util/tag-name";
import { Version } from "release-please/build/src/version";
import { discoverWorkspaces } from "../release";
import { WorkspacePlugin } from "../workspace-plugin";

const ROOT = resolve(import.meta.dirname, "../../../..");

test("configured alpha releases begin at 0.0.1 and breaking commits stay on 0.0.x", async () => {
  const github = await GitHub.create({
    defaultBranch: "main",
    owner: "test",
    repo: "test",
  });
  const reader = spyOn(github, "getFileContentsOnBranch").mockImplementation(
    async (path) => {
      const parsedContent = readFileSync(join(ROOT, path), "utf8");
      return {
        content: Buffer.from(parsedContent).toString("base64"),
        mode: "100644",
        parsedContent,
        sha: "a".repeat(40),
      };
    }
  );
  try {
    const manifest = await Manifest.fromManifest(github, "main");
    const configuration = manifest.repositoryConfig["apps/marbles"];
    if (!configuration) {
      throw new Error("Missing Marbles release configuration");
    }
    const strategy = await buildStrategy({
      ...configuration,
      github,
      path: "apps/marbles",
      targetBranch: "main",
    });
    const commits = parseConventionalCommits([
      {
        message:
          "feat(marbles)!: replace the API\n\nBREAKING CHANGE: migrate the API",
        sha: "b".repeat(40),
      },
    ]);
    expect(
      (await strategy.buildReleasePullRequest(commits))?.version?.toString()
    ).toBe("0.0.1");
    const next = await strategy.buildReleasePullRequest(commits, {
      notes: "alpha",
      sha: "c".repeat(40),
      tag: new TagName(Version.parse("0.0.1"), "marbles"),
    });
    expect(next?.version?.toString()).toBe("0.0.2");
    expect(next?.body.toString()).toContain("BREAKING CHANGES");
  } finally {
    reader.mockRestore();
  }
});

test("only public apps have release components while private libraries stay version-aligned", () => {
  const config = JSON.parse(
    readFileSync(join(ROOT, "release-please-config.json"), "utf8")
  );
  const workspaces = discoverWorkspaces(ROOT);
  expect(Object.keys(config.packages)).toContain("apps/marbles");
  for (const path of Object.keys(config.packages)) {
    const workspace = workspaces.find(({ directory }) => directory === path);
    expect(path.startsWith("apps/")).toBe(true);
    expect(workspace).toBeDefined();
    expect(workspace?.manifest.private).toBe(false);
  }
  const libraries = workspaces.filter(({ directory }) =>
    directory.startsWith("packages/")
  );
  expect(libraries.length).toBeGreaterThan(0);
  expect(new Set(libraries.map(({ manifest }) => manifest.version)).size).toBe(
    1
  );
  for (const library of libraries) {
    expect(library.manifest.private).toBe(true);
  }
});

test("release preparation rejects a private workspace or library group", async () => {
  const github = await GitHub.create({
    defaultBranch: "main",
    owner: "test",
    repo: "test",
  });
  const strategy = await buildStrategy({
    github,
    releaseType: "simple",
    targetBranch: "main",
  });
  const plugin = new WorkspacePlugin(github, "main", {}, ROOT);
  for (const path of ["apps/works", "packages", "packages/core"]) {
    await expect(
      plugin.preconfigure({ [path]: strategy }, {}, {})
    ).rejects.toThrow("must be a public app workspace");
  }
});

test("release proposals format versions and regenerate lockfiles without modifying the checkout or running scripts", async () => {
  const root = mkdtempSync(join(tmpdir(), "release-lock-test-"));
  try {
    mkdirSync(join(root, "apps/example"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", private: true, workspaces: ["apps/*"] })
    );
    const path = "apps/example/package.json";
    const manifest = {
      name: "fixture-app",
      scripts: { prepare: "exit 99" },
      version: "0.0.1",
    };
    writeFileSync(join(root, path), JSON.stringify(manifest));
    execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
      cwd: root,
      stdio: "pipe",
    });
    const before = readFileSync(join(root, "bun.lock"), "utf8");
    const version = Version.parse("0.0.2");
    const candidate: CandidateReleasePullRequest = {
      config: { releaseType: "node" },
      path: "apps/example",
      pullRequest: {
        body: new PullRequestBody([]),
        draft: false,
        headRefName: "release-example",
        labels: [],
        title: PullRequestTitle.ofVersion(version),
        updates: [
          {
            createIfMissing: false,
            path,
            updater: {
              updateContent: () =>
                JSON.stringify({ ...manifest, version: "0.0.2" }),
            },
          },
          {
            createIfMissing: false,
            path: ".release-please-manifest.json",
            updater: new ReleasePleaseManifest({
              version,
              versionsMap: new Map([["apps/example", version]]),
            }),
          },
        ],
      },
    };
    const github = await GitHub.create({
      defaultBranch: "main",
      owner: "test",
      repo: "test",
    });
    await new WorkspacePlugin(github, "main", {}, root).run([candidate]);
    const manifestUpdate = candidate.pullRequest.updates.find(
      (update) => update.path === ".release-please-manifest.json"
    );
    expect(manifestUpdate?.updater.updateContent("{}\n")).toBe(
      '{\n  "apps/example": "0.0.2"\n}\n'
    );
    expect(
      JSON.parse(
        manifestUpdate?.updater.updateContent('{"apps/another":"0.1.0"}\n') ??
          "{}"
      )
    ).toEqual({ "apps/another": "0.1.0", "apps/example": "0.0.2" });
    const after = candidate.pullRequest.updates
      .find((update) => update.path === "bun.lock")
      ?.updater.updateContent(before);
    if (!after) {
      throw new Error("Missing release lockfile");
    }
    expect(after).toContain('"version": "0.0.2"');
    expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(join(root, path), "utf8")).version).toBe(
      "0.0.1"
    );
    writeFileSync(
      join(root, path),
      JSON.stringify({ ...manifest, version: "0.0.2" })
    );
    writeFileSync(join(root, "bun.lock"), after);
    expect(() =>
      execFileSync(
        "bun",
        ["install", "--frozen-lockfile", "--ignore-scripts"],
        { cwd: root, stdio: "pipe" }
      )
    ).not.toThrow();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
