import { describe, expect, it } from "vitest";

import type { AnalysisConfig } from "../../src/lib/config";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type { HotspotSource } from "../../src/lib/hotspots";
import { analyzeHotspots } from "../../src/lib/hotspots";
import { renderHotspots } from "../../src/lib/report";
import type {
  ChurnFileKind,
  ChurnReport,
  DependencyGravity,
  FileChurn,
  FunctionComplexity,
} from "../../src/lib/types";

const expectedTextPattern = /refactor|risk|score/i;

interface FileOptions {
  commitPercentile?: number;
  commits?: number;
  kind?: ChurnFileKind;
  linesChanged?: number;
}

function churnFile(file: string, options: FileOptions = {}): FileChurn {
  const commits = options.commits ?? 1;
  const linesChanged = options.linesChanged ?? commits * 10;
  return {
    additions: linesChanged,
    authors: 1,
    commits,
    daysSinceLastChange: 2,
    deletions: 0,
    file,
    kind: options.kind ?? "source",
    lastChangedAt: "2026-05-30T00:00:00Z",
    linesChanged,
    rank: {
      commitPercentile: options.commitPercentile ?? 0.5,
      lineChurnPercentile: 0.5,
    },
  };
}

interface FunctionOptions {
  controlFlow?: number;
  expression?: number;
  nesting?: number;
  statements?: number;
}

function fn(
  file: string,
  line: number,
  options: FunctionOptions = {}
): FunctionComplexity {
  const controlFlow = options.controlFlow ?? 0;
  const expression = options.expression ?? 0;
  return {
    exported: false,
    file,
    id: `${file}#L${line}C1#fn${line}`,
    kind: "function",
    line,
    metrics: {
      async: { async: false, awaits: 0, generator: false, yields: 0 },
      callbacks: { maxDepth: 0, nestedFunctions: 0 },
      decisions: {
        cases: 0,
        catches: 0,
        controlFlow,
        defaults: 0,
        elseIfs: 0,
        expression,
        ifs: controlFlow,
        logical: 0,
        loops: 0,
        switches: 0,
        ternaries: expression,
        total: controlFlow + expression,
      },
      exceptions: { catches: 0, finals: 0, tries: 0 },
      exits: { breaks: 0, continues: 0, returns: 1, throws: 0 },
      loops: { doWhile: 0, for: 0, forIn: 0, forOf: 0, total: 0, while: 0 },
      nesting: { max: options.nesting ?? 0 },
      parameters: { boolean: 0, defaulted: 0, optional: 0, rest: 0, total: 0 },
      statements: options.statements ?? 1,
    },
    name: `fn${line}`,
    packagePublic: false,
  };
}

function moduleGravity(
  id: string,
  fanIn: number,
  fanOut: number
): DependencyGravity {
  return {
    cycle: { member: false, size: 0 },
    depth: { downstream: 1, upstream: 1 },
    direct: { fanIn, fanOut },
    node: { id, kind: "module" },
    reach: { dependencies: 0, dependents: 0 },
    transitive: { dependencies: fanOut * 2, dependents: fanIn * 3 },
  };
}

const emptyDistribution = { max: 0, p50: 0, p90: 0, p95: 0 };
const emptyDistributions = {
  authorsPerFile: emptyDistribution,
  commitsPerFile: emptyDistribution,
  daysSinceLastChange: emptyDistribution,
  linesChangedPerFile: emptyDistribution,
};

function churnOf(files: FileChurn[]): ChurnReport {
  const totals = { commits: 0, files: 0, linesChanged: 0 };
  return {
    available: true,
    distributions: emptyDistributions,
    files,
    history: {
      analyzedAt: "2026-06-01T00:00:00.000Z",
      commitsAnalyzed: 100,
      historyComplete: true,
      windowDays: 365,
    },
    repository: {
      commits: 100,
      distributions: emptyDistributions,
      filesAnalyzed: files.length,
    },
    summary: {
      additions: 0,
      authors: 1,
      byKind: {
        config: totals,
        other: totals,
        source: totals,
        story: totals,
        test: totals,
      },
      commits: 100,
      deletedFiles: 0,
      deletions: 0,
      filesAnalyzed: files.length,
      linesChanged: 0,
    },
    target: {
      additions: 0,
      authors: 1,
      commits: 100,
      deletions: 0,
      id: "@fixture/pkg",
      kind: "package",
      linesChanged: 0,
    },
  };
}

function sourceOf(
  files: FileChurn[],
  functions: FunctionComplexity[] = [],
  modules: DependencyGravity[] = []
): HotspotSource {
  return {
    churn: churnOf(files),
    dependencyGravity: {
      incomingConcentration: [],
      internalEdges: [],
      modules,
      outgoingConcentration: [],
      population: { modules: modules.length, packages: 1 },
      target: moduleGravity("@fixture/pkg", 0, 0),
    },
    localComplexity: {
      functions,
      summary: {
        controlFlowDecisions: {
          average: 0,
          distribution: emptyDistribution,
          total: 0,
        },
        decisions: { average: 0, distribution: emptyDistribution, total: 0 },
        functionsAnalyzed: functions.length,
        nesting: { average: 0, distribution: emptyDistribution, total: 0 },
        parameters: { average: 0, distribution: emptyDistribution, total: 0 },
        statements: { average: 0, distribution: emptyDistribution, total: 0 },
      },
    },
    target: { boundaryType: "package", name: "@fixture/pkg", path: "pkg" },
  };
}

function hotspotsOf(source: HotspotSource, config?: AnalysisConfig) {
  const report = analyzeHotspots(source, config);
  if (!report.available) {
    throw new Error(report.reason);
  }
  return report;
}

const HOT = "pkg/src/hot.ts";

describe("hotspot eligibility", () => {
  it("qualifies high churn meeting high complexity with both signals", () => {
    const report = hotspotsOf(
      sourceOf(
        [churnFile(HOT, { commitPercentile: 0.98, commits: 20 })],
        [fn(HOT, 1, { controlFlow: 8, nesting: 4, statements: 30 })]
      )
    );
    expect(report.summary).toEqual({
      eligibleSourceFiles: 1,
      filesAboveCommitP90: 1,
      filesAboveCommitP95: 1,
      hotspotShare: 1,
      hotspots: 1,
    });
    const [hotspot] = report.files;
    expect(hotspot?.signals).toEqual([
      "frequent-change",
      "branch-heavy",
      "deep-control-flow",
    ]);
    expect(hotspot?.evolution).toMatchObject({
      commitPercentile: 0.98,
      commits: 20,
      linesChanged: 200,
    });
    expect(hotspot?.complexity).toEqual({
      controlFlowDecisions: { max: 8, total: 8 },
      expressionDecisions: { max: 0, total: 0 },
      functions: 1,
      nesting: { max: 4 },
      statements: { max: 30, total: 30 },
    });
    expect(hotspot?.architecture).toEqual({ package: "@fixture/pkg" });
  });

  it("rejects frequent change over trivial structure", () => {
    const report = hotspotsOf(
      sourceOf(
        [churnFile(HOT, { commitPercentile: 0.99, commits: 40 })],
        [fn(HOT, 1, { controlFlow: 1, nesting: 1 })]
      )
    );
    expect(report.files).toEqual([]);
    expect(report.summary.filesAboveCommitP95).toBe(1);
  });

  it("rejects a complex file that rarely changes", () => {
    const report = hotspotsOf(
      sourceOf(
        [churnFile(HOT, { commitPercentile: 0.3, commits: 1 })],
        [fn(HOT, 1, { controlFlow: 20, nesting: 5 })]
      )
    );
    expect(report.files).toEqual([]);
  });

  it("names deep-control-flow for depth without heavy branching", () => {
    const [hotspot] = hotspotsOf(
      sourceOf(
        [churnFile(HOT, { commitPercentile: 0.95, commits: 20 })],
        [fn(HOT, 1, { controlFlow: 3, nesting: 4 })]
      )
    ).files;
    expect(hotspot?.signals).toEqual(["frequent-change", "deep-control-flow"]);
    expect(
      hotspotsOf(
        sourceOf(
          [churnFile(HOT, { commitPercentile: 0.95, commits: 20 })],
          [fn(HOT, 1, { controlFlow: 3, nesting: 3 })]
        )
      ).files
    ).toEqual([]);
  });

  it("names branch-heavy for flat, decision-dense functions", () => {
    const [hotspot] = hotspotsOf(
      sourceOf(
        [churnFile(HOT, { commitPercentile: 0.95, commits: 20 })],
        [fn(HOT, 1, { controlFlow: 9, nesting: 1 })]
      )
    ).files;
    expect(hotspot?.signals).toEqual(["frequent-change", "branch-heavy"]);
  });

  it("names complexity-dense when many moderate functions accumulate", () => {
    const functions = Array.from({ length: 6 }, (_, i) =>
      fn(HOT, i + 1, { controlFlow: 3, nesting: 1 })
    );
    const [hotspot] = hotspotsOf(
      sourceOf(
        [churnFile(HOT, { commitPercentile: 0.95, commits: 20 })],
        functions
      )
    ).files;
    expect(hotspot?.signals).toEqual(["frequent-change", "complexity-dense"]);
    expect(hotspot?.complexity.controlFlowDecisions).toEqual({
      max: 3,
      total: 18,
    });
  });

  it("does not qualify on JSX expression branching alone", () => {
    const report = hotspotsOf(
      sourceOf(
        [
          churnFile("pkg/src/view.tsx", {
            commitPercentile: 0.97,
            commits: 20,
          }),
        ],
        [
          fn("pkg/src/view.tsx", 1, {
            controlFlow: 2,
            expression: 40,
            nesting: 1,
          }),
          fn("pkg/src/view.tsx", 60, { controlFlow: 1, expression: 25 }),
        ]
      )
    );
    expect(report.files).toEqual([]);
  });

  it("leaves non-source kinds in churn but out of hotspots", () => {
    const report = hotspotsOf(
      sourceOf(
        [
          churnFile("pkg/drizzle/snapshot.json", {
            commitPercentile: 0.99,
            commits: 50,
            kind: "other",
            linesChanged: 90_000,
          }),
          churnFile("pkg/src/a.test.ts", {
            commitPercentile: 0.99,
            commits: 50,
            kind: "test",
          }),
        ],
        [fn("pkg/src/a.test.ts", 1, { controlFlow: 12, nesting: 4 })]
      )
    );
    expect(report.summary.eligibleSourceFiles).toBe(0);
    expect(report.files).toEqual([]);
  });

  it("adds architecturally-central from module gravity when configured", () => {
    const [hotspot] = hotspotsOf(
      sourceOf(
        [churnFile(HOT, { commitPercentile: 0.95, commits: 20 })],
        [fn(HOT, 1, { controlFlow: 7 })],
        [moduleGravity(HOT, 45, 3)]
      )
    ).files;
    expect(hotspot?.signals).toContain("architecturally-central");
    expect(hotspot?.architecture).toEqual({
      moduleGravity: {
        fanIn: 45,
        fanOut: 3,
        transitiveDependencies: 6,
        transitiveDependents: 135,
      },
      package: "@fixture/pkg",
    });
  });

  it("never lets gravity alone create a hotspot", () => {
    const report = hotspotsOf(
      sourceOf(
        [churnFile(HOT, { commitPercentile: 0.95, commits: 20 })],
        [fn(HOT, 1, { controlFlow: 1 })],
        [moduleGravity(HOT, 200, 40)]
      )
    );
    expect(report.files).toEqual([]);
  });

  it("keeps a hotspot valid without a gravity match", () => {
    const [hotspot] = hotspotsOf(
      sourceOf(
        [churnFile(HOT, { commitPercentile: 0.95, commits: 20 })],
        [fn(HOT, 1, { controlFlow: 7 })],
        [moduleGravity("pkg/src/elsewhere.ts", 100, 100)]
      )
    ).files;
    expect(hotspot?.architecture?.moduleGravity).toBeUndefined();
    expect(hotspot?.signals).toEqual(["frequent-change", "branch-heavy"]);
  });

  it("reads every gate from config", () => {
    const source = sourceOf(
      [churnFile(HOT, { commitPercentile: 0.8, commits: 5 })],
      [fn(HOT, 1, { controlFlow: 4, nesting: 2 })]
    );
    expect(hotspotsOf(source).files).toEqual([]);
    const relaxed: AnalysisConfig = {
      ...ANALYSIS_CONFIG,
      hotspots: {
        ...ANALYSIS_CONFIG.hotspots,
        gates: {
          complexity: {
            ...ANALYSIS_CONFIG.hotspots.gates.complexity,
            minMaxControlFlowDecisions: 4,
          },
          minCommitPercentile: 0.75,
        },
      },
    };
    expect(hotspotsOf(source, relaxed).files.map((f) => f.file)).toEqual([HOT]);
    const testsToo: AnalysisConfig = {
      ...relaxed,
      hotspots: { ...relaxed.hotspots, eligibleKinds: ["source", "test"] },
    };
    const withTest = sourceOf(
      [
        churnFile("pkg/src/a.test.ts", {
          commitPercentile: 0.9,
          commits: 9,
          kind: "test",
        }),
      ],
      [fn("pkg/src/a.test.ts", 1, { controlFlow: 6 })]
    );
    expect(hotspotsOf(withTest, testsToo).summary.hotspots).toBe(1);
  });

  it("orders by commit percentile, commits, max control flow, then path", () => {
    const files = [
      churnFile("pkg/src/c.ts", { commitPercentile: 0.95, commits: 10 }),
      churnFile("pkg/src/a.ts", { commitPercentile: 0.95, commits: 10 }),
      churnFile("pkg/src/b.ts", { commitPercentile: 0.95, commits: 12 }),
      churnFile("pkg/src/d.ts", { commitPercentile: 0.99, commits: 30 }),
    ];
    const functions = [
      fn("pkg/src/c.ts", 1, { controlFlow: 6 }),
      fn("pkg/src/a.ts", 1, { controlFlow: 9 }),
      fn("pkg/src/b.ts", 1, { controlFlow: 6 }),
      fn("pkg/src/d.ts", 1, { controlFlow: 6 }),
    ];
    const order = hotspotsOf(sourceOf(files, functions)).files.map(
      (f) => f.file
    );
    expect(order).toEqual([
      "pkg/src/d.ts",
      "pkg/src/b.ts",
      "pkg/src/a.ts",
      "pkg/src/c.ts",
    ]);
    const again = hotspotsOf(sourceOf([...files].reverse(), functions));
    expect(again.files.map((f) => f.file)).toEqual(order);
    expect(again.files[2]?.rank.complexityPercentile).toBe(0.75);
  });

  it("propagates churn unavailability", () => {
    const source: HotspotSource = {
      ...sourceOf([]),
      churn: { available: false, reason: "not-git-repository" },
    };
    expect(analyzeHotspots(source)).toEqual({
      available: false,
      reason: "not-git-repository",
    });
    expect(
      renderHotspots({
        hotspots: analyzeHotspots(source),
        target: source.target,
      })
    ).toContain("Hotspot analysis unavailable: not git repository");
  });

  it("renders vectors and signals", () => {
    const source = sourceOf(
      [churnFile(HOT, { commitPercentile: 0.984, commits: 20 })],
      [
        fn(HOT, 1, {
          controlFlow: 8,
          expression: 3,
          nesting: 4,
          statements: 30,
        }),
      ],
      [moduleGravity(HOT, 45, 3)]
    );
    const text = renderHotspots({
      hotspots: analyzeHotspots(source),
      target: source.target,
    });
    expect(text).toContain("Eligible source files  1");
    expect(text).toContain("      20 commits\n      commit percentile 98.4%");
    expect(text).toContain("control-flow decisions  max 8 · total 8");
    expect(text).toContain("fan-in 45 · fan-out 3");
    expect(text).toContain(
      "    Signals\n      frequent-change\n      branch-heavy\n      deep-control-flow\n      architecturally-central"
    );
    expect(text).not.toMatch(expectedTextPattern);
  });
});
