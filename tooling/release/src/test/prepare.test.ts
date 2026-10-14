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
import type { ExtraFile } from "release-please/build/src/manifest";
import { TagName } from "release-please/build/src/util/tag-name";
import { Version } from "release-please/build/src/version";
import { buildReleaseLockfile } from "../lockfile";
import { discoverWorkspaces } from "../release";

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

test("the library group updates every library together and preserves workspace dependencies and privacy", async () => {
  const config = JSON.parse(
    readFileSync(join(ROOT, "release-please-config.json"), "utf8")
  );
  const github = await GitHub.create({
    defaultBranch: "main",
    owner: "test",
    repo: "test",
  });
  const strategy = await buildStrategy({
    bumpMinorPreMajor: true,
    component: "libraries",
    extraFiles: config.packages.packages["extra-files"] as ExtraFile[],
    github,
    path: "packages",
    releaseType: "simple",
    targetBranch: "main",
  });
  const proposal = await strategy.buildReleasePullRequest(
    parseConventionalCommits([
      {
        message: "feat(agents)!: replace the library API",
        sha: "b".repeat(40),
      },
    ]),
    {
      notes: "initial",
      sha: "c".repeat(40),
      tag: new TagName(Version.parse("0.1.0"), "libraries"),
    }
  );
  expect(proposal?.version?.toString()).toBe("0.2.0");
  const libraries = discoverWorkspaces(ROOT).filter(({ directory }) =>
    directory.startsWith("packages/")
  );
  for (const library of libraries) {
    const path = `${library.directory}/package.json`;
    const update = proposal?.updates.find(
      (candidate) => candidate.path === path
    );
    expect(update).toBeDefined();
    const updated = JSON.parse(
      update?.updater.updateContent(readFileSync(join(ROOT, path), "utf8")) ??
        "{}"
    );
    expect(updated.version).toBe("0.2.0");
    expect(updated.private).toBe(true);
    expect(updated.dependencies).toEqual(library.manifest.dependencies);
  }
});

test("Bun regenerates each proposed lockfile without modifying the checkout or running scripts", () => {
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
    const after = buildReleaseLockfile(root, [
      {
        createIfMissing: false,
        path,
        updater: {
          updateContent: () =>
            JSON.stringify({ ...manifest, version: "0.0.2" }),
        },
      },
    ]);
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
