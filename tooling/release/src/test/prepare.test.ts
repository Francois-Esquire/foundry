import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GitHub, Manifest } from "release-please";
import { parseConventionalCommits } from "release-please/build/src/commit";
import { buildStrategy } from "release-please/build/src/factory";
import type { CandidateReleasePullRequest } from "release-please/build/src/manifest";
import type { PullRequest } from "release-please/build/src/pull-request";
import type { ReleasePullRequest } from "release-please/build/src/release-pull-request";
import { ReleasePleaseManifest } from "release-please/build/src/updaters/release-please-manifest";
import { PullRequestBody } from "release-please/build/src/util/pull-request-body";
import { PullRequestTitle } from "release-please/build/src/util/pull-request-title";
import { TagName } from "release-please/build/src/util/tag-name";
import { Version } from "release-please/build/src/version";
import { discoverWorkspaces } from "../release";
import { WorkspacePlugin } from "../workspace-plugin";

const ROOT = resolve(import.meta.dirname, "../../../..");

test("existing release PRs receive file fixes even when release notes are unchanged", async () => {
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
  const version = Version.parse("0.0.1");
  const proposal: ReleasePullRequest = {
    body: new PullRequestBody([
      {
        component: "marbles",
        notes: "## 0.0.1 (2026-10-14)\n\n### Bug Fixes\n\n* Same notes",
        version,
      },
    ]),
    draft: false,
    headRefName: "release-please--branches--main--components--marbles",
    labels: ["autorelease: pending"],
    title: PullRequestTitle.ofComponentTargetBranchVersion(
      "marbles",
      "main",
      version
    ),
    updates: [
      {
        createIfMissing: false,
        path: ".release-please-manifest.json",
        updater: { updateContent: () => '{\n  "apps/marbles": "0.0.1"\n}\n' },
      },
    ],
    version,
  };
  const existing: PullRequest = {
    baseBranchName: "main",
    body: proposal.body.toString(),
    files: [],
    headBranchName: proposal.headRefName,
    labels: proposal.labels,
    number: 3,
    title: proposal.title.toString(),
  };
  const iterator = spyOn(github, "pullRequestIterator").mockImplementation(
    async function* (_branch, state) {
      if (state === "OPEN") {
        yield existing;
      }
    }
  );
  const update = spyOn(github, "updatePullRequest").mockResolvedValue(existing);
  try {
    const manifest = await Manifest.fromManifest(github, "main");
    const build = spyOn(manifest, "buildPullRequests").mockResolvedValue([
      proposal,
    ]);
    try {
      expect(
        (await manifest.createPullRequests()).map(
          (pullRequest) => pullRequest?.number
        )
      ).toEqual([3]);
      expect(update).toHaveBeenCalledWith(
        3,
        proposal,
        "main",
        expect.anything()
      );
    } finally {
      build.mockRestore();
    }
  } finally {
    reader.mockRestore();
    iterator.mockRestore();
    update.mockRestore();
  }
});

test.each(["marbles", "spyglass"])(
  "%s alpha releases begin at 0.0.1 and breaking commits stay on 0.0.x",
  async (component) => {
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
      const configuration = manifest.repositoryConfig[`apps/${component}`];
      if (!configuration) {
        throw new Error(`Missing ${component} release configuration`);
      }
      const strategy = await buildStrategy({
        ...configuration,
        github,
        path: `apps/${component}`,
        targetBranch: "main",
      });
      const commits = parseConventionalCommits([
        {
          message: `feat(${component})!: replace the API\n\nBREAKING CHANGE: migrate the API`,
          sha: "b".repeat(40),
        },
      ]);
      expect(
        (await strategy.buildReleasePullRequest(commits))?.version?.toString()
      ).toBe("0.0.1");
      const next = await strategy.buildReleasePullRequest(commits, {
        notes: "alpha",
        sha: "c".repeat(40),
        tag: new TagName(Version.parse("0.0.1"), component),
      });
      expect(next?.version?.toString()).toBe("0.0.2");
      expect(next?.body.toString()).toContain("BREAKING CHANGES");
    } finally {
      reader.mockRestore();
    }
  }
);

test("app components are public and libraries share a dormant version group", () => {
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
    ).rejects.toThrow("must be a public app or library workspace");
  }
});

test("release proposals format the version manifest and leave bun.lock to the repository", async () => {
  const version = Version.parse("0.0.2");
  const path = "apps/marbles/package.json";
  const candidate: CandidateReleasePullRequest = {
    config: { releaseType: "node" },
    path: "apps/marbles",
    pullRequest: {
      body: new PullRequestBody([]),
      draft: false,
      headRefName: "release-marbles",
      labels: [],
      title: PullRequestTitle.ofVersion(version),
      updates: [
        {
          createIfMissing: false,
          path,
          updater: { updateContent: (content) => content ?? "" },
        },
        {
          createIfMissing: false,
          path: ".release-please-manifest.json",
          updater: new ReleasePleaseManifest({
            version,
            versionsMap: new Map([["apps/marbles", version]]),
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
  const [proposal] = await new WorkspacePlugin(github, "main", {}, ROOT).run([
    candidate,
  ]);
  const updates = proposal?.pullRequest.updates ?? [];
  expect(updates.map((update) => update.path)).toEqual([
    path,
    ".release-please-manifest.json",
  ]);
  const manifestUpdate = updates.find(
    (update) => update.path === ".release-please-manifest.json"
  );
  expect(manifestUpdate?.updater.updateContent("{}\n")).toBe(
    '{\n  "apps/marbles": "0.0.2"\n}\n'
  );
  expect(
    JSON.parse(
      manifestUpdate?.updater.updateContent('{"apps/another":"0.1.0"}\n') ??
        "{}"
    )
  ).toEqual({ "apps/another": "0.1.0", "apps/marbles": "0.0.2" });
});
