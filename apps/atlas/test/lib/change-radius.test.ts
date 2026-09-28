import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Boundary } from "../../src/lib/boundary";
import { analyzeChangeRadius } from "../../src/lib/change-radius";
import type { AnalysisConfig } from "../../src/lib/config";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type { CommitChange, GitHistory } from "../../src/lib/git-history";
import { renderRadius } from "../../src/lib/report";
import type { WorkspaceModuleGraph } from "../../src/lib/types";

const expectedTextPattern = /risk|blast|cross-cutting/i;

const ROOT = join(tmpdir(), "semantic-surface-radius-fixture");
const A1 = "packages/a/src/a1.ts";
const A2 = "packages/a/src/a2.ts";
const A3 = "packages/a/src/a3.ts";
const AT = "packages/a/src/tests/a.test.ts";
const AC = "packages/a/vitest.config.ts";
const B1 = "packages/b/src/b1.ts";
const C1 = "packages/c/src/c1.ts";
const ALL = [A1, A2, A3, AT, AC, B1, C1];

const boundary: Boundary = {
  dir: join(ROOT, "packages/a"),
  explicitlyPublishable: false,
  exportSubpaths: null,
  packageName: "@fixture/a",
  relPath: "packages/a",
  root: ROOT,
  type: "package",
};

function commit(
  index: number,
  files: string[],
  lines: [number | null, number | null] = [1, 0]
): CommitChange {
  return {
    author: "Alice",
    files: files.map((file) => ({
      additions: lines[0],
      deletions: lines[1],
      path: file,
    })),
    hash: `c${String(index).padStart(2, "0")}`,
    timestamp: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
  };
}

function historyOf(commits: CommitChange[], tracked = ALL): GitHistory {
  return {
    analyzedAt: "2026-06-01T00:00:00.000Z",
    available: true,
    commits: [...commits].reverse(),
    root: ROOT,
    shallow: false,
    trackedFiles: tracked,
  };
}

function graphOf(edges: [string, string][]): WorkspaceModuleGraph {
  return {
    edges: edges.map(([fromFile, toFile]) => ({ fromFile, toFile })),
    modules: [A1, A2, A3, AT, B1, C1],
    owners: {
      [A1]: "@fixture/a",
      [A2]: "@fixture/a",
      [A3]: "@fixture/a",
      [AT]: "@fixture/a",
      [AC]: "@fixture/a",
      [B1]: "@fixture/b",
      [C1]: "@fixture/c",
    },
  };
}

const config: AnalysisConfig = {
  ...ANALYSIS_CONFIG,
  churn: { ...ANALYSIS_CONFIG.churn, windowDays: null },
};

function radiusOf(
  commits: CommitChange[],
  edges: [string, string][] = [],
  override: AnalysisConfig = config,
  tracked?: string[]
) {
  const report = analyzeChangeRadius(
    historyOf(commits, tracked),
    { boundary, graph: graphOf(edges) },
    override
  );
  if (!report.available) {
    throw new Error(report.reason);
  }
  return report;
}

function only(report: ReturnType<typeof radiusOf>) {
  const [first] = report.commits;
  if (first === undefined || report.commits.length !== 1) {
    throw new Error(`expected one commit, got ${report.commits.length}`);
  }
  return first;
}

describe("change radius", () => {
  it("measures a single-file commit", () => {
    expect(only(radiusOf([commit(1, [A1])]))).toMatchObject({
      files: 1,
      packageBoundariesCrossed: 0,
      packageSet: ["@fixture/a"],
      packages: 1,
      sourceFiles: 1,
      targetFileShare: 1,
      targetFiles: 1,
      targetPackages: 1,
    });
  });

  it("keeps several files in one package at package radius 1", () => {
    expect(only(radiusOf([commit(1, [A1, A2, A3])]))).toMatchObject({
      files: 3,
      packageBoundariesCrossed: 0,
      packages: 1,
    });
  });

  it("counts a boundary when touched packages share a static edge", () => {
    expect(only(radiusOf([commit(1, [A1, B1])], [[A1, B1]]))).toMatchObject({
      packageBoundariesCrossed: 1,
      packages: 2,
    });
  });

  it("counts no boundary between unrelated packages", () => {
    expect(only(radiusOf([commit(1, [A1, B1])]))).toMatchObject({
      packageBoundariesCrossed: 0,
      packages: 2,
    });
  });

  it("counts only existing edges along a chain", () => {
    const report = radiusOf(
      [commit(1, [A1, B1, C1])],
      [
        [A1, B1],
        [B1, C1],
      ]
    );
    expect(only(report)).toMatchObject({
      packageBoundariesCrossed: 2,
      packageSet: ["@fixture/a", "@fixture/b", "@fixture/c"],
      packages: 3,
    });
  });

  it("deduplicates packages and package edges from many module edges", () => {
    const report = radiusOf(
      [commit(1, [A1, A2, A3, B1])],
      [
        [A1, B1],
        [A2, B1],
        [A3, B1],
      ]
    );
    expect(only(report)).toMatchObject({
      files: 4,
      packageBoundariesCrossed: 1,
      packages: 2,
    });
  });

  it("measures full repository radius for target-touching commits", () => {
    const report = radiusOf([commit(1, [A1, B1, C1]), commit(2, [B1, C1])]);
    expect(report.commits).toHaveLength(1);
    expect(only(report)).toMatchObject({
      packages: 3,
      targetFileShare: 1 / 3,
      targetFiles: 1,
    });
    expect(report.history.commitsObserved).toBe(1);
  });

  it("splits files by kind and sums line totals over counted files", () => {
    const report = radiusOf([
      commit(1, [A1, AT, AC, "packages/a/README.md"], [3, 2]),
    ]);
    expect(only(report)).toMatchObject({
      additions: 9,
      deletions: 6,
      files: 3,
      filesByKind: { config: 1, other: 0, source: 1, test: 1 },
      linesChanged: 15,
      sourceFiles: 1,
    });
  });

  it("reports null lines when every counted change is binary", () => {
    const report = radiusOf([commit(1, [A1], [null, null])]);
    expect(only(report)).toMatchObject({
      additions: null,
      deletions: null,
      linesChanged: null,
    });
  });

  it("ignores excluded directories and deleted files", () => {
    const report = radiusOf(
      [commit(1, [A1, "packages/a/dist/a1.js", "packages/a/src/gone.ts"])],
      [],
      config,
      [A1, "packages/a/dist/a1.js"]
    );
    expect(only(report).files).toBe(1);
  });

  it("keeps oversized commits out of distributions but in metadata", () => {
    const many = Array.from({ length: 5 }, (_, i) => `packages/a/src/g${i}.ts`);
    const report = radiusOf(
      [commit(1, many), commit(2, [A1, B1])],
      [],
      {
        ...config,
        history: {
          ...config.history,
          oversized: { ...config.history.oversized, maxCodeFilesPerCommit: 3 },
        },
      },
      [...ALL, ...many]
    );
    expect(report.history).toEqual({
      commitsEligible: 1,
      commitsExcluded: 1,
      commitsObserved: 2,
      oversized: { configSweepMinPackages: 5, maxCodeFilesPerCommit: 3 },
      windowDays: null,
    });
    expect(report.summary.files.max).toBe(2);
  });

  it("computes nearest-rank distributions and both rates exactly", () => {
    const report = radiusOf(
      [
        commit(1, [A1]),
        commit(2, [A1, A2]),
        commit(3, [A1, B1]),
        commit(4, [A1, B1, C1]),
        commit(5, [A1, C1]),
      ],
      [[A1, B1]]
    );
    expect(report.summary).toMatchObject({
      boundaries: { max: 1, p50: 0, p90: 1, p95: 1 },
      boundaryCrossingCommits: 2,
      boundaryCrossingRate: 0.4,
      commits: 5,
      crossPackageCommits: 3,
      crossPackageRate: 0.6,
      files: { max: 3, p50: 2, p90: 3, p95: 3 },
      packages: { max: 3, p50: 2, p90: 3, p95: 3 },
      singlePackageCommits: 2,
    });
    // Equal support: smaller sets first, then lexical.
    expect(report.summary.packageCombinations).toEqual([
      { commits: 1, packages: ["@fixture/a", "@fixture/b"] },
      { commits: 1, packages: ["@fixture/a", "@fixture/c"] },
      { commits: 1, packages: ["@fixture/a", "@fixture/b", "@fixture/c"] },
    ]);
  });

  it("orders commits by packages, source files, files, time, hash", () => {
    const commits = [
      commit(1, [A1, B1]),
      commit(2, [A1, A2, B1]),
      commit(3, [A1, A2, A3]),
      commit(4, [A1, B1, C1]),
    ];
    const order = radiusOf(commits).commits.map((c) => c.hash);
    expect(order).toEqual(["c04", "c02", "c01", "c03"]);
    expect(radiusOf([...commits].reverse()).commits.map((c) => c.hash)).toEqual(
      order
    );
  });

  it("applies the churn window", () => {
    const report = radiusOf([commit(1, [A1, B1]), commit(140, [A1])], [], {
      ...config,
      churn: { ...config.churn, windowDays: 30 },
    });
    expect(report.commits.map((c) => c.hash)).toEqual(["c140"]);
  });

  it("propagates unavailable history", () => {
    const history: GitHistory = {
      analyzedAt: "2026-06-01T00:00:00.000Z",
      available: false,
      reason: "not-git-repository",
      root: ROOT,
    };
    expect(
      analyzeChangeRadius(history, { boundary, graph: graphOf([]) })
    ).toEqual({ available: false, reason: "not-git-repository" });
  });

  it("renders distributions, rates, and the widest commit", () => {
    const report = radiusOf(
      [commit(1, [A1, B1, C1]), commit(2, [A1])],
      [[A1, B1]]
    );
    const text = renderRadius({
      changeRadius: report,
      target: {
        boundaryType: "package",
        name: "@fixture/a",
        path: "packages/a",
      },
    });
    expect(text).toContain(
      "Packages / commit       p50 1 · p90 3 · p95 3 · max 3"
    );
    expect(text).toContain("Cross-package commits      1 / 2 · 50.0%");
    expect(text).toContain("Boundary-crossing commits  1 / 2 · 50.0%");
    expect(text).toContain(
      "WIDEST COMMITS\n\n  c01  2026-01-02\n    files       3 (3 source · 0 test · 0 config)\n    packages    3\n    boundaries  1"
    );
    expect(text).not.toMatch(expectedTextPattern);
  });
});

describe("shared commit filter", () => {
  it("excludes a config-dominant sweep across packages but keeps a wide source refactor", () => {
    const manifests = ["a", "b", "c", "d", "e"].map(
      (name) => `packages/${name}/package.json`
    );
    const refactor = Array.from(
      { length: 39 },
      (_, i) => `packages/a/src/r${i}.ts`
    );
    const graph: WorkspaceModuleGraph = {
      edges: [],
      modules: [A1, B1, ...refactor],
      owners: {
        [A1]: "@fixture/a",
        [B1]: "@fixture/b",
        ...Object.fromEntries(refactor.map((file) => [file, "@fixture/a"])),
        ...Object.fromEntries(
          manifests.map((file, i) => [file, `@fixture/${"abcde"[i]}`])
        ),
      },
    };
    const report = analyzeChangeRadius(
      historyOf(
        [
          commit(1, [A1, ...manifests]),
          commit(2, [A1, ...refactor]),
          commit(3, [A1, ...refactor, B1]),
        ],
        [A1, B1, ...manifests, ...refactor]
      ),
      { boundary, graph },
      config
    );
    if (!report.available) {
      throw new Error(report.reason);
    }
    expect(report.history).toMatchObject({
      commitsEligible: 1,
      commitsExcluded: 2,
      commitsObserved: 3,
    });
    expect(report.commits.map((c) => [c.hash, c.files, c.composition])).toEqual(
      [["c02", 40, "source-dominant"]]
    );
  });

  it("counts repository-root files but never as a package", () => {
    const report = radiusOf(
      [commit(1, [A1, "package.json", "turbo.json"])],
      [],
      config,
      [...ALL, "package.json", "turbo.json"]
    );
    expect(only(report)).toMatchObject({
      composition: "config-dominant",
      files: 3,
      filesByKind: { config: 2, other: 0, source: 1, story: 0, test: 0 },
      packageSet: ["@fixture/a"],
      packages: 1,
    });
    expect(report.summary.crossPackageRate).toBe(0);
  });

  it("labels composition by config share", () => {
    const mixed = only(radiusOf([commit(1, [A1, A2, AC])]));
    expect(mixed.composition).toBe("mixed");
    expect(only(radiusOf([commit(2, [A1, A2, A3, AT])])).composition).toBe(
      "source-dominant"
    );
  });
});
