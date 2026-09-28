import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import type { Boundary } from "../../src/lib/boundary";
import { analyzeChurn } from "../../src/lib/churn";
import type { AnalysisConfig } from "../../src/lib/config";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import { classifyFile } from "../../src/lib/file-kind";
import type { GitHistory } from "../../src/lib/git-history";
import { collectGitHistory, parseGitLog } from "../../src/lib/git-history";
import { renderChurn, renderReport } from "../../src/lib/report";

const expectedTextPattern = /hotspot/i;
const expectedTextPattern2 = /@example\.com/;

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "semantic-surface-churn-"));
  tempRoots.push(dir);
  return dir;
}

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync("git", args, {
    cwd: dir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "ignore"],
  }).toString();
}

function initRepo(): string {
  const dir = tempDir();
  git(dir, ["init", "-q"]);
  return dir;
}

interface CommitOptions {
  author?: string;
  date: string;
  files?: Record<string, string | Buffer>;
  remove?: string[];
  rename?: [string, string];
}

/** Commit with deterministic author and committer dates. */
function commit(dir: string, options: CommitOptions): string {
  for (const [file, content] of Object.entries(options.files ?? {})) {
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  for (const file of options.remove ?? []) {
    git(dir, ["rm", "-q", file]);
  }
  if (options.rename !== undefined) {
    git(dir, ["mv", options.rename[0], options.rename[1]]);
  }
  git(dir, ["add", "-A"]);
  const author = options.author ?? "Alice";
  git(
    dir,
    [
      "-c",
      `user.name=${author}`,
      "-c",
      `user.email=${author.toLowerCase()}@example.com`,
      "commit",
      "-qm",
      "fixture",
    ],
    { GIT_AUTHOR_DATE: options.date, GIT_COMMITTER_DATE: options.date }
  );
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

const NOW = new Date("2026-06-01T00:00:00Z");

function boundaryOf(root: string, relPath = "pkg"): Boundary {
  return {
    dir: join(root, relPath),
    explicitlyPublishable: false,
    exportSubpaths: null,
    packageName: "@fixture/pkg",
    relPath,
    root,
    type: "package",
  };
}

function withWindow(windowDays: number | null): AnalysisConfig {
  return {
    ...ANALYSIS_CONFIG,
    churn: { ...ANALYSIS_CONFIG.churn, windowDays },
  };
}

async function churnOf(
  dir: string,
  config: AnalysisConfig = withWindow(null),
  relPath = "pkg"
) {
  const history = await collectGitHistory(dir, { now: NOW });
  const report = analyzeChurn(history, boundaryOf(dir, relPath), config);
  if (!report.available) {
    throw new Error(`unavailable: ${report.reason}`);
  }
  return report;
}

function fileOf(report: Awaited<ReturnType<typeof churnOf>>, file: string) {
  const found = report.files.find((entry) => entry.file === file);
  if (found === undefined) {
    throw new Error(`no churn record for ${file}`);
  }
  return found;
}

describe("git history collector", () => {
  it("parses commits, numstat, renames, and binary records", () => {
    const log =
      "\x01aaa\0" +
      "2026-01-01T00:00:00+00:00\0Alice\0\n" +
      "3\t1\tpkg/a.ts\0" +
      "-\t-\tpkg/logo.png\0" +
      "2\t2\t\0pkg/old.ts\0pkg/new.ts\0" +
      "\x01bbb\0" +
      "2025-12-01T00:00:00+00:00\0Bob\0\n" +
      "10\t0\tpkg/a.ts\0";
    expect(parseGitLog(log)).toEqual([
      {
        author: "Alice",
        files: [
          { additions: 3, deletions: 1, path: "pkg/a.ts" },
          { additions: null, deletions: null, path: "pkg/logo.png" },
          {
            additions: 2,
            deletions: 2,
            path: "pkg/new.ts",
            previousPath: "pkg/old.ts",
          },
        ],
        hash: "aaa",
        timestamp: "2026-01-01T00:00:00+00:00",
      },
      {
        author: "Bob",
        files: [{ additions: 10, deletions: 0, path: "pkg/a.ts" }],
        hash: "bbb",
        timestamp: "2025-12-01T00:00:00+00:00",
      },
    ]);
  });

  it("reports a directory outside Git as unavailable", async () => {
    const history = await collectGitHistory(tempDir(), { now: NOW });
    expect(history.available).toBe(false);
    if (!history.available) {
      expect(history.reason).toBe("not-git-repository");
    }
  });

  it("collects newest-first commits and tracked files", async () => {
    const dir = initRepo();
    const first = commit(dir, {
      date: "2026-01-01T00:00:00Z",
      files: { "pkg/a.ts": "a\n" },
    });
    const second = commit(dir, {
      date: "2026-02-01T00:00:00Z",
      files: { "pkg/b.ts": "b\n" },
    });
    const history = await collectGitHistory(dir, { now: NOW });
    expect(history.available).toBe(true);
    if (!history.available) {
      return;
    }
    expect(history.shallow).toBe(false);
    expect(history.commits.map((entry) => entry.hash)).toEqual([second, first]);
    expect(history.trackedFiles).toEqual(["pkg/a.ts", "pkg/b.ts"]);
  });
});

describe("churn analysis", () => {
  it("counts commits, additions, and deletions per file exactly", async () => {
    const dir = initRepo();
    commit(dir, {
      date: "2026-01-01T00:00:00Z",
      files: { "pkg/a.ts": "1\n2\n3\n", "pkg/b.ts": "x\n" },
    });
    commit(dir, {
      date: "2026-02-01T00:00:00Z",
      files: { "pkg/a.ts": "1\n2\n" },
    });
    commit(dir, {
      date: "2026-03-01T00:00:00Z",
      files: { "pkg/b.ts": "x\ny\nz\n" },
    });
    const report = await churnOf(dir);
    const a = fileOf(report, "pkg/a.ts");
    expect(a.commits).toBe(2);
    expect(a.additions).toBe(3);
    expect(a.deletions).toBe(1);
    expect(a.linesChanged).toBe(4);
    const b = fileOf(report, "pkg/b.ts");
    expect(b.commits).toBe(2);
    expect(b.additions).toBe(3);
    expect(b.deletions).toBe(0);
    expect(report.summary.commits).toBe(3);
    expect(report.summary.linesChanged).toBe(7);
    expect(report.summary.filesAnalyzed).toBe(2);
    expect(report.target).toMatchObject({
      commits: 3,
      id: "@fixture/pkg",
      kind: "package",
      linesChanged: 7,
    });
  });

  it("counts a commit touching several files once for the package", async () => {
    const dir = initRepo();
    commit(dir, {
      date: "2026-01-01T00:00:00Z",
      files: { "pkg/a.ts": "a\n", "pkg/b.ts": "b\n" },
    });
    const report = await churnOf(dir);
    expect(fileOf(report, "pkg/a.ts").commits).toBe(1);
    expect(fileOf(report, "pkg/b.ts").commits).toBe(1);
    expect(report.summary.commits).toBe(1);
    expect(report.history.commitsAnalyzed).toBe(1);
  });

  it("records first and last change and recency against the analysis clock", async () => {
    const dir = initRepo();
    commit(dir, { date: "2026-01-01T00:00:00Z", files: { "pkg/a.ts": "a\n" } });
    commit(dir, { date: "2026-05-30T12:00:00Z", files: { "pkg/a.ts": "b\n" } });
    const report = await churnOf(dir);
    const a = fileOf(report, "pkg/a.ts");
    expect(a.firstChangedAt).toBe("2026-01-01T00:00:00Z");
    expect(a.lastChangedAt).toBe("2026-05-30T12:00:00Z");
    expect(a.daysSinceLastChange).toBe(1);
    expect(report.target.lastChangedAt).toBe("2026-05-30T12:00:00Z");
    expect(report.target.daysSinceLastChange).toBe(1);
    expect(report.history.analyzedAt).toBe(NOW.toISOString());
  });

  it("counts distinct authors and the primary author's share", async () => {
    const dir = initRepo();
    for (const [author, date] of [
      ["Alice", "2026-01-01T00:00:00Z"],
      ["Alice", "2026-01-02T00:00:00Z"],
      ["Bob", "2026-01-03T00:00:00Z"],
      ["Carol", "2026-01-04T00:00:00Z"],
    ] as const) {
      commit(dir, { author, date, files: { "pkg/a.ts": `${date}\n` } });
    }
    commit(dir, {
      author: "Bob",
      date: "2026-01-05T00:00:00Z",
      files: { "pkg/b.ts": "b\n" },
    });
    const report = await churnOf(dir);
    const a = fileOf(report, "pkg/a.ts");
    expect(a.authors).toBe(3);
    expect(a.ownership).toEqual({
      primaryAuthor: "Alice",
      primaryAuthorShare: 0.5,
    });
    expect(fileOf(report, "pkg/b.ts").authors).toBe(1);
    expect(report.summary.authors).toBe(3);
    expect(report.distributions.authorsPerFile).toEqual({
      max: 3,
      p50: 1,
      p90: 3,
      p95: 3,
    });
  });

  it("limits counts to the window but keeps full-history recency", async () => {
    const dir = initRepo();
    commit(dir, {
      date: "2025-01-01T00:00:00Z",
      files: { "pkg/a.ts": "a\n", "pkg/old.ts": "1\n2\n3\n" },
    });
    commit(dir, { date: "2026-05-20T00:00:00Z", files: { "pkg/a.ts": "b\n" } });
    const report = await churnOf(dir, withWindow(30));
    expect(report.history.windowDays).toBe(30);
    expect(report.history.since).toBe("2026-05-02T00:00:00.000Z");
    expect(report.history.commitsAnalyzed).toBe(1);
    const a = fileOf(report, "pkg/a.ts");
    expect(a.commits).toBe(1);
    expect(a.linesChanged).toBe(2);
    expect(a.firstChangedAt).toBe("2025-01-01T00:00:00Z");
    const old = fileOf(report, "pkg/old.ts");
    expect(old.commits).toBe(0);
    expect(old.linesChanged).toBe(0);
    expect(old.authors).toBe(0);
    expect(old.ownership).toBeUndefined();
    expect(old.lastChangedAt).toBe("2025-01-01T00:00:00Z");
    expect(old.daysSinceLastChange).toBe(516);
    expect(report.summary.commits).toBe(1);
    expect(report.summary.authors).toBe(1);
  });

  it("follows history across a rename onto the current path", async () => {
    const dir = initRepo();
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    commit(dir, {
      date: "2026-01-01T00:00:00Z",
      files: { "pkg/old.ts": `${body}\n` },
    });
    commit(dir, {
      date: "2026-02-01T00:00:00Z",
      files: { "pkg/old.ts": `${body}\nmore\n` },
    });
    commit(dir, {
      date: "2026-03-01T00:00:00Z",
      rename: ["pkg/old.ts", "pkg/new.ts"],
    });
    commit(dir, {
      date: "2026-04-01T00:00:00Z",
      files: { "pkg/new.ts": `${body}\nmore\nagain\n` },
    });
    const report = await churnOf(dir);
    expect(report.files.map((file) => file.file)).toEqual(["pkg/new.ts"]);
    const renamed = fileOf(report, "pkg/new.ts");
    expect(renamed.commits).toBe(4);
    expect(renamed.additions).toBe(22);
    expect(renamed.firstChangedAt).toBe("2026-01-01T00:00:00Z");
    expect(report.summary.deletedFiles).toBe(0);
  });

  it("keeps commit counts for binary files without line churn", async () => {
    const dir = initRepo();
    commit(dir, {
      date: "2026-01-01T00:00:00Z",
      files: { "pkg/logo.png": Buffer.from([0, 1, 2, 3, 0, 255]) },
    });
    commit(dir, {
      date: "2026-02-01T00:00:00Z",
      files: { "pkg/logo.png": Buffer.from([0, 9, 9, 9, 0, 255, 1]) },
    });
    const report = await churnOf(dir);
    const logo = fileOf(report, "pkg/logo.png");
    expect(logo.commits).toBe(2);
    expect(logo.linesChanged).toBe(0);
    expect(logo.kind).toBe("other");
  });

  it("counts deleted files separately and omits them from files", async () => {
    const dir = initRepo();
    commit(dir, {
      date: "2026-01-01T00:00:00Z",
      files: { "pkg/a.ts": "a\n", "pkg/gone.ts": "g\n" },
    });
    commit(dir, { date: "2026-02-01T00:00:00Z", remove: ["pkg/gone.ts"] });
    const report = await churnOf(dir);
    expect(report.files.map((file) => file.file)).toEqual(["pkg/a.ts"]);
    expect(report.summary.deletedFiles).toBe(1);
    expect(report.summary.commits).toBe(1);
  });

  it("ignores excluded generated directories and files outside the target", async () => {
    const dir = initRepo();
    commit(dir, {
      date: "2026-01-01T00:00:00Z",
      files: {
        "other/b.ts": "b\n",
        "pkg/dist/a.js": "built\n",
        "pkg/src/a.ts": "a\n",
        "pkg/storybook-static/index.html": "<html>\n",
      },
    });
    const report = await churnOf(dir);
    expect(report.files.map((file) => file.file)).toEqual(["pkg/src/a.ts"]);
    expect(report.repository.filesAnalyzed).toBe(2);
    expect(report.repository.commits).toBe(1);
  });

  it("splits totals by file kind", async () => {
    const dir = initRepo();
    commit(dir, {
      date: "2026-01-01T00:00:00Z",
      files: {
        "pkg/package.json": "{}\n",
        "pkg/README.md": "# a\n",
        "pkg/src/a.test.ts": "1\n2\n",
        "pkg/src/a.ts": "1\n2\n3\n4\n",
        "pkg/test/setup.ts": "1\n",
        "pkg/vitest.config.ts": "export {}\n",
      },
    });
    const report = await churnOf(dir);
    expect(report.summary.byKind).toEqual({
      config: { commits: 1, files: 2, linesChanged: 2 },
      other: { commits: 1, files: 1, linesChanged: 1 },
      source: { commits: 1, files: 1, linesChanged: 4 },
      story: { commits: 0, files: 0, linesChanged: 0 },
      test: { commits: 1, files: 2, linesChanged: 3 },
    });
    expect(classifyFile("packages/x/.eslintrc.json")).toBe("config");
    expect(classifyFile("packages/x/src/__tests__/a.ts")).toBe("test");
    expect(classifyFile("packages/x/src/button.stories.tsx")).toBe("story");
    expect(classifyFile("packages/x/src/stories/editor/fixtures.ts")).toBe(
      "story"
    );
    expect(classifyFile("packages/x/src/stories/a.test.ts")).toBe("test");
    expect(classifyFile("packages/x/src/a.tsx")).toBe("source");
    expect(classifyFile("packages/x/schema.sql")).toBe("other");
  });

  it("computes nearest-rank distributions over file values", async () => {
    const dir = initRepo();
    const counts: Record<string, number> = {
      "pkg/a.ts": 1,
      "pkg/b.ts": 2,
      "pkg/c.ts": 3,
      "pkg/d.ts": 10,
      "pkg/notes.md": 50,
    };
    let day = 0;
    for (const [file, times] of Object.entries(counts)) {
      for (let i = 0; i < times; i += 1) {
        commit(dir, {
          date: new Date(Date.UTC(2026, 0, 1, 0, 0, day)).toISOString(),
          files: { [file]: `${i}\n` },
        });
        day += 1;
      }
    }
    const report = await churnOf(dir);
    expect(report.distributions.commitsPerFile).toEqual({
      max: 50,
      p50: 3,
      p90: 50,
      p95: 50,
    });
    expect(report.distributions.linesChangedPerFile.max).toBe(99);
    // Rank is the share of same-kind repository files strictly below; the
    // 50-commit markdown file is another kind and does not move source ranks.
    expect(
      report.files.map((file) => [file.file, file.rank.commitPercentile])
    ).toEqual([
      ["pkg/a.ts", 0],
      ["pkg/b.ts", 0.25],
      ["pkg/c.ts", 0.5],
      ["pkg/d.ts", 0.75],
      ["pkg/notes.md", 0],
    ]);
  });

  it("flags shallow clones as incomplete history", async () => {
    const dir = initRepo();
    const head = commit(dir, {
      date: "2026-01-01T00:00:00Z",
      files: { "pkg/a.ts": "a\n" },
    });
    writeFileSync(join(dir, ".git", "shallow"), `${head}\n`);
    expect(git(dir, ["rev-parse", "--is-shallow-repository"]).trim()).toBe(
      "true"
    );
    const report = await churnOf(dir);
    expect(report.history.historyComplete).toBe(false);
    expect(
      renderChurn({
        churn: report,
        target: { boundaryType: "package", path: "pkg" },
      })
    ).toContain("shallow clone");
  });

  it("renders the focused view with rankings and the default block", async () => {
    const dir = initRepo();
    commit(dir, {
      author: "Alice",
      date: "2026-05-01T00:00:00Z",
      files: { "pkg/a.ts": "1\n2\n", "pkg/b.ts": "1\n" },
    });
    commit(dir, {
      author: "Bob",
      date: "2026-05-31T00:00:00Z",
      files: { "pkg/a.ts": "1\n2\n3\n" },
    });
    const report = await churnOf(dir);
    const text = renderChurn({
      churn: report,
      target: { boundaryType: "package", name: "@fixture/pkg", path: "pkg" },
    });
    expect(text).toContain("full history");
    expect(text).toContain("  commits         2");
    expect(text).toContain("  last changed    1 day ago");
    expect(text).toContain(
      "MOST FREQUENTLY CHANGED\n\n  pkg/a.ts\n    2 commits · 3 lines changed · 2 authors"
    );
    expect(text).toContain("primary author share 50.0%");
    expect(text).not.toMatch(expectedTextPattern2);
    expect(text).not.toMatch(expectedTextPattern);
  });
});

describe("analyzeSurface outside Git", () => {
  it("still builds the report and marks churn unavailable", async () => {
    const dir = tempDir();
    cpSync(join(import.meta.dirname, "fixtures", "traffic"), dir, {
      recursive: true,
    });
    const report = await analyzeSurface({ root: dir, target: "@traffic/hub" });
    expect(report.schemaVersion).toBe(35);
    expect(report.churn).toEqual({
      available: false,
      reason: "not-git-repository",
    });
    expect(report.hotspots).toEqual({
      available: false,
      reason: "not-git-repository",
    });
    expect(report.changeCoupling).toEqual({
      available: false,
      reason: "not-git-repository",
    });
    expect(report.changeRadius).toEqual({
      available: false,
      reason: "not-git-repository",
    });
    expect(report.evolutionaryPressure).toEqual({
      available: false,
      reason: "not-git-repository",
    });
    expect(renderReport(report)).toContain(
      "CHURN\n  unavailable — not git repository"
    );
  });

  it("attaches churn when the root is a repository", async () => {
    const dir = tempDir();
    cpSync(join(import.meta.dirname, "fixtures", "traffic"), dir, {
      recursive: true,
    });
    git(dir, ["init", "-q"]);
    commit(dir, { date: "2026-01-01T00:00:00Z" });
    const report = await analyzeSurface({ root: dir, target: "@traffic/hub" });
    expect(report.churn.available).toBe(true);
    if (!report.churn.available) {
      return;
    }
    expect(report.churn.summary.commits).toBe(1);
    expect(report.churn.files.length).toBeGreaterThan(0);
    const history: GitHistory = await collectGitHistory(dir);
    expect(history.available).toBe(true);
  });
});
