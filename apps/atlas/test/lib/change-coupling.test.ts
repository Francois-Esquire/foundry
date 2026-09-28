import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Boundary } from "../../src/lib/boundary";
import { analyzeChangeCoupling } from "../../src/lib/change-coupling";
import type { AnalysisConfig } from "../../src/lib/config";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type { CommitChange, GitHistory } from "../../src/lib/git-history";
import { renderCoupling } from "../../src/lib/report";
import type { WorkspaceModuleGraph } from "../../src/lib/types";

const expectedTextPattern = /merge|move|missing dependency/i;

const ROOT = join(tmpdir(), "semantic-surface-coupling-fixture");
const A = "packages/a/src/a.ts";
const B = "packages/a/src/b.ts";
const C = "packages/a/src/c.ts";
const X = "packages/b/src/x.ts";
const Y = "packages/b/src/y.ts";

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
  previous: Record<string, string> = {}
): CommitChange {
  return {
    author: "Alice",
    files: files.map((file) => ({
      additions: 1,
      deletions: 0,
      path: file,
      ...(previous[file] !== undefined && { previousPath: previous[file] }),
    })),
    hash: `c${index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
  };
}

function historyOf(
  commits: CommitChange[],
  tracked: string[] = [A, B, C, X, Y]
): GitHistory {
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
    modules: [A, B, C, X, Y],
    owners: {
      [A]: "@fixture/a",
      [B]: "@fixture/a",
      [C]: "@fixture/a",
      [X]: "@fixture/b",
      [Y]: "@fixture/b",
    },
  };
}

/** Full-history window and gates that keep 2-commit fixtures visible. */
const config: AnalysisConfig = {
  ...ANALYSIS_CONFIG,
  changeCoupling: {
    ...ANALYSIS_CONFIG.changeCoupling,
    gates: { ...ANALYSIS_CONFIG.changeCoupling.gates, minCoChangeCommits: 2 },
  },
  churn: { ...ANALYSIS_CONFIG.churn, windowDays: null },
};

function couplingOf(
  commits: CommitChange[],
  edges: [string, string][] = [],
  override: AnalysisConfig = config,
  tracked?: string[]
) {
  const report = analyzeChangeCoupling(
    historyOf(commits, tracked),
    { boundary, graph: graphOf(edges) },
    override
  );
  if (!report.available) {
    throw new Error(report.reason);
  }
  return report;
}

function pairOf(
  report: ReturnType<typeof couplingOf>,
  left: string,
  right: string
) {
  const pair = report.filePairs.find(
    (candidate) => candidate.left === left && candidate.right === right
  );
  if (pair === undefined) {
    throw new Error(`no pair ${left} ↔ ${right}`);
  }
  return pair;
}

describe("change coupling", () => {
  it("measures perfect coupling", () => {
    const report = couplingOf([
      commit(1, [A, B]),
      commit(2, [A, B]),
      commit(3, [A, B]),
    ]);
    expect(pairOf(report, A, B)).toMatchObject({
      coChangeCommits: 3,
      jaccard: 1,
      lastCoChangedAt: "2026-01-04T00:00:00.000Z",
      leftCommits: 3,
      leftConditional: 1,
      rightCommits: 3,
      rightConditional: 1,
      scope: "same-package",
      staticRelation: "none",
    });
  });

  it("preserves both directions of asymmetric coupling", () => {
    const report = couplingOf([
      commit(1, [A, B]),
      commit(2, [A, B]),
      commit(3, [A]),
      commit(4, [A]),
    ]);
    expect(pairOf(report, A, B)).toMatchObject({
      coChangeCommits: 2,
      leftCommits: 4,
      leftConditional: 0.5,
      rightCommits: 2,
      rightConditional: 1,
    });
  });

  it("computes Jaccard over the union of commits", () => {
    const commits = [
      ...Array.from({ length: 8 }, (_, i) => commit(i + 1, [A, B])),
      ...Array.from({ length: 12 }, (_, i) => commit(i + 9, [A])),
      ...Array.from({ length: 2 }, (_, i) => commit(i + 21, [B])),
    ];
    const pair = pairOf(couplingOf(commits), A, B);
    expect(pair.leftCommits).toBe(20);
    expect(pair.rightCommits).toBe(10);
    expect(pair.jaccard).toBeCloseTo(8 / 22, 10);
  });

  it("drops pairs below minimum support", () => {
    const report = couplingOf([commit(1, [A, B])], [], {
      ...config,
      changeCoupling: {
        ...config.changeCoupling,
        gates: { ...config.changeCoupling.gates, minCoChangeCommits: 3 },
      },
    });
    expect(report.filePairs).toEqual([]);
    expect(report.history.observedFilePairs).toBe(1);
  });

  it("drops pairs below every strength gate", () => {
    const commits = [
      commit(1, [A, B]),
      commit(2, [A, B]),
      ...Array.from({ length: 8 }, (_, i) => commit(i + 3, [A])),
      ...Array.from({ length: 8 }, (_, i) => commit(i + 11, [B])),
    ];
    // 2 / 10 each way, Jaccard 2/18: below 0.5 / 0.5 / 0.3.
    expect(couplingOf(commits).filePairs).toEqual([]);
  });

  it("excludes oversized commits from pair generation only", () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => `packages/a/src/gen${i}.ts`
    );
    const report = couplingOf(
      [commit(1, many), commit(2, [A, B]), commit(3, [A, B])],
      [],
      {
        ...config,
        history: {
          ...config.history,
          oversized: { ...config.history.oversized, maxCodeFilesPerCommit: 20 },
        },
      },
      [A, B, C, X, Y, ...many]
    );
    expect(report.history).toMatchObject({
      commitsConsidered: 2,
      commitsExcluded: 1,
      observedFilePairs: 1,
      oversized: { maxCodeFilesPerCommit: 20 },
    });
    expect(report.filePairs.map((p) => [p.left, p.right])).toEqual([[A, B]]);
  });

  it("classifies the static relation from current edges", () => {
    const commits = [commit(1, [A, B, C, X]), commit(2, [A, B, C, X])];
    const report = couplingOf(commits, [
      [A, B],
      [C, A],
      [A, X],
      [X, A],
    ]);
    expect(pairOf(report, A, B).staticRelation).toBe("left-to-right");
    expect(pairOf(report, A, C).staticRelation).toBe("right-to-left");
    expect(pairOf(report, A, X).staticRelation).toBe("bidirectional");
    expect(pairOf(report, B, C).staticRelation).toBe("none");
  });

  it("marks pairs with a non-module side as unmeasured", () => {
    const pkg = "packages/a/package.json";
    const report = couplingOf(
      [commit(1, [A, pkg]), commit(2, [A, pkg])],
      [],
      config,
      [A, pkg]
    );
    expect(pairOf(report, pkg, A).staticRelation).toBe("unmeasured");
    expect(report.summary.filePairsWithoutStaticEdge).toBe(0);
  });

  it("reports strong coupling with no static dependency", () => {
    const report = couplingOf(
      [commit(1, [A, B]), commit(2, [A, B]), commit(3, [A, B])],
      [[A, C]]
    );
    expect(report.summary.filePairsWithoutStaticEdge).toBe(1);
    expect(pairOf(report, A, B).staticRelation).toBe("none");
  });

  it("collapses package co-change to one per commit", () => {
    const report = couplingOf(
      [commit(1, [A, B, C, X, Y]), commit(2, [A, X]), commit(3, [A, B, X])],
      [[A, X]]
    );
    expect(report.packagePairs).toEqual([
      {
        coChangeCommits: 3,
        jaccard: 1,
        lastCoChangedAt: "2026-01-04T00:00:00.000Z",
        left: "@fixture/a",
        leftCommits: 3,
        leftConditional: 1,
        right: "@fixture/b",
        rightCommits: 3,
        rightConditional: 1,
        staticPath: "direct",
        staticRelation: "left-to-right",
      },
    ]);
    expect(report.summary.packagePairsWithoutStaticEdge).toBe(0);
  });

  it("classifies same-package and cross-package file pairs", () => {
    const report = couplingOf([commit(1, [A, B, X]), commit(2, [A, B, X])]);
    expect(pairOf(report, A, B)).toMatchObject({
      leftPackage: "@fixture/a",
      rightPackage: "@fixture/a",
      scope: "same-package",
    });
    expect(pairOf(report, A, X)).toMatchObject({
      leftPackage: "@fixture/a",
      rightPackage: "@fixture/b",
      scope: "cross-package",
    });
    expect(report.summary).toMatchObject({
      crossPackagePairs: 2,
      filePairs: 3,
      samePackagePairs: 1,
    });
  });

  it("omits pairs that do not touch the target", () => {
    const report = couplingOf([commit(1, [X, Y]), commit(2, [X, Y])]);
    expect(report.filePairs).toEqual([]);
    expect(report.packagePairs).toEqual([]);
    expect(report.history.observedFilePairs).toBe(1);
  });

  it("ignores ineligible kinds and files that no longer exist", () => {
    const snapshot = "packages/a/drizzle/snapshot.json";
    const gone = "packages/a/src/gone.ts";
    const report = couplingOf(
      [commit(1, [A, snapshot, gone]), commit(2, [A, snapshot, gone])],
      [],
      config,
      [A, snapshot]
    );
    expect(report.filePairs).toEqual([]);
    // A alone still counts toward its own commit total.
    expect(report.history.commitsConsidered).toBe(2);
    expect(report.history.observedFilePairs).toBe(0);
  });

  it("follows renames onto the current path", () => {
    const old = "packages/a/src/old.ts";
    const report = couplingOf([
      commit(1, [old, B]),
      commit(2, [old, B]),
      commit(3, [A], { [A]: old }),
      commit(4, [A, B]),
    ]);
    expect(pairOf(report, A, B)).toMatchObject({
      coChangeCommits: 3,
      leftCommits: 4,
      rightCommits: 3,
    });
  });

  it("applies the churn window", () => {
    const windowed: AnalysisConfig = {
      ...config,
      churn: { ...config.churn, windowDays: 30 },
    };
    const report = couplingOf(
      [
        commit(1, [A, B]),
        commit(2, [A, B]),
        commit(140, [A, B]),
        commit(141, [A, B]),
      ],
      [],
      windowed
    );
    expect(pairOf(report, A, B).coChangeCommits).toBe(2);
    expect(report.history.windowDays).toBe(30);
  });

  it("summarizes partners per target file", () => {
    const report = couplingOf([
      commit(1, [A, B, C]),
      commit(2, [A, B, C]),
      commit(3, [A, B]),
      commit(4, [A, X]),
      commit(5, [A, X]),
    ]);
    expect(report.files[0]).toEqual({
      file: A,
      partners: 3,
      strongest: { conditional: 0.6, file: B, jaccard: 0.6 },
    });
    expect(report.files.map((f) => f.file)).toEqual([A, B, C]);
  });

  it("orders pairs by support, Jaccard, conditional, then ids", () => {
    const commits = [
      commit(1, [A, B]),
      commit(2, [A, B]),
      commit(3, [A, B]),
      commit(4, [A, C]),
      commit(5, [A, C]),
      commit(6, [B, C]),
      commit(7, [B, C]),
    ];
    // A|B: 3 shared, Jaccard 3/7. A|C and B|C: 2 shared of 5 and 4 commits,
    // Jaccard 2/7 and C's conditional 0.5 each — tie broken lexically.
    const order = couplingOf(commits).filePairs.map(
      (p) => `${p.left}|${p.right}`
    );
    expect(order).toEqual([`${A}|${B}`, `${A}|${C}`, `${B}|${C}`]);
    const again = couplingOf([...commits].reverse()).filePairs.map(
      (p) => `${p.left}|${p.right}`
    );
    expect(again).toEqual(order);
  });

  it("propagates unavailable history", () => {
    const history: GitHistory = {
      analyzedAt: "2026-06-01T00:00:00.000Z",
      available: false,
      reason: "not-git-repository",
      root: ROOT,
    };
    const report = analyzeChangeCoupling(history, {
      boundary,
      graph: graphOf([]),
    });
    expect(report).toEqual({ available: false, reason: "not-git-repository" });
  });

  it("renders every direction with support visible", () => {
    const report = couplingOf(
      [commit(1, [A, B]), commit(2, [A, B]), commit(3, [A])],
      [[A, B]]
    );
    const text = renderCoupling({
      changeCoupling: report,
      target: {
        boundaryType: "package",
        name: "@fixture/a",
        path: "packages/a",
      },
    });
    expect(text).toContain("co-change commits      2");
    expect(text).toContain("left commits           3 · right commits 2");
    expect(text).toContain("left → right           66.7%");
    expect(text).toContain("right → left           100.0%");
    expect(text).toContain("static relation        left → right");
    expect(text).not.toContain("TEMPORALLY COUPLED WITHOUT STATIC EDGE");
    expect(text).not.toMatch(expectedTextPattern);
  });
});

describe("static path", () => {
  const commits = [commit(1, [A, C]), commit(2, [A, C])];

  it("resolves a barrel-mediated pair as indirect", () => {
    const report = couplingOf(commits, [
      [A, B],
      [B, C],
    ]);
    expect(pairOf(report, A, C)).toMatchObject({
      staticPath: "indirect",
      staticRelation: "none",
    });
    expect(report.summary).toMatchObject({
      filePairsWithoutStaticEdge: 1,
      filePairsWithoutStaticPath: 0,
    });
  });

  it("keeps a pair with no path at all as none", () => {
    const report = couplingOf(commits, [[A, B]]);
    expect(pairOf(report, A, C)).toMatchObject({
      staticPath: "none",
      staticRelation: "none",
    });
    expect(report.summary.filePairsWithoutStaticPath).toBe(1);
  });

  it("restates a direct edge and leaves unmeasured files alone", () => {
    const report = couplingOf(
      [
        commit(1, [A, C, "packages/a/tsconfig.json"]),
        commit(2, [A, C, "packages/a/tsconfig.json"]),
      ],
      [[C, A]],
      config,
      [A, B, C, X, Y, "packages/a/tsconfig.json"]
    );
    expect(pairOf(report, A, C).staticPath).toBe("direct");
    expect(pairOf(report, A, "packages/a/tsconfig.json").staticPath).toBe(
      "unmeasured"
    );
  });
});

describe("pair context", () => {
  it("names the file kinds a pair joins", () => {
    const test = "packages/a/src/tests/a.test.ts";
    const story = "packages/a/src/stories/a.stories.tsx";
    const manifest = "packages/a/package.json";
    const other = "packages/b/package.json";
    const report = couplingOf(
      [
        commit(1, [A, test, story, manifest, other]),
        commit(2, [A, test, story, manifest, other]),
      ],
      [],
      config,
      [A, B, C, X, Y, test, story, manifest, other]
    );
    expect(pairOf(report, A, test).context).toBe("source-test");
    expect(pairOf(report, A, story).context).toBe("story-related");
    expect(pairOf(report, manifest, other).context).toBe("config-config");
    expect(pairOf(report, manifest, A).context).toBe("mixed");
  });
});
