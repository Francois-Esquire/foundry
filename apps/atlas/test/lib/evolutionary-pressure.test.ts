import { describe, expect, it } from "vitest";

import type { AnalysisConfig } from "../../src/lib/config";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type { EvolutionaryPressureSource } from "../../src/lib/evolutionary-pressure";
import { analyzeEvolutionaryPressure } from "../../src/lib/evolutionary-pressure";
import { analyzeHotspots } from "../../src/lib/hotspots";
import { renderEvolution } from "../../src/lib/report";
import type {
  ArchitecturalProfileSignalResult,
  ChangeCouplingReport,
  ChangeRadiusReport,
  ChurnReport,
  CouplingContext,
  DependencyGravity,
  FileChangeCouplingPair,
  FileChurn,
  FileHotspot,
  HotspotReport,
  MetricDistribution,
  PackageChangeCoupling,
  PackageCombination,
  PressureEvidence,
  StaticPathRelation,
  StaticRelation,
  StructuralPressureKind,
  StructuralPressureSignal,
} from "../../src/lib/types";

const expectedTextPattern = /recommend|should|merge|fold|priority/i;

const TARGET = "@fixture/a";
const STUDIO = "@fixture/studio";
const A_INDEX = "packages/a/src/index.ts";
const A_CORE = "packages/a/src/core.ts";
const A_STORE = "packages/a/src/store.ts";
const S_MAIN = "apps/studio/src/main.ts";
const B_MEMORY = "packages/b/src/memory.ts";

function dist(value = 0): MetricDistribution {
  return { max: value, p50: value, p90: value, p95: value };
}

function aggregate() {
  return { average: 0, distribution: dist(), total: 0 };
}

function gravity(
  id: string,
  kind: "package" | "module",
  fanIn: number,
  fanOut: number
): DependencyGravity {
  return {
    cycle: { member: false, size: 0 },
    depth: { downstream: 1, upstream: 1 },
    direct: { fanIn, fanOut },
    node: { id, kind },
    reach: { dependencies: 0, dependents: 0 },
    transitive: { dependencies: fanOut, dependents: fanIn },
  };
}

function churnFile(
  file: string,
  commits: number,
  commitPercentile: number
): FileChurn {
  return {
    additions: commits,
    authors: 1,
    commits,
    deletions: 0,
    file,
    kind: "source",
    linesChanged: commits,
    rank: { commitPercentile, lineChurnPercentile: commitPercentile },
  };
}

function churnReport(files: FileChurn[], commits: number): ChurnReport {
  const kind = { commits: 0, files: 0, linesChanged: 0 };
  const distributions = {
    authorsPerFile: dist(),
    commitsPerFile: dist(),
    daysSinceLastChange: dist(),
    linesChangedPerFile: dist(),
  };
  return {
    available: true,
    distributions,
    files,
    history: {
      analyzedAt: "2026-06-01T00:00:00.000Z",
      commitsAnalyzed: commits,
      historyComplete: true,
      windowDays: 365,
    },
    repository: { commits: 1000, distributions, filesAnalyzed: 100 },
    summary: {
      additions: 0,
      authors: 1,
      byKind: {
        config: kind,
        other: kind,
        source: kind,
        story: kind,
        test: kind,
      },
      commits,
      deletedFiles: 0,
      deletions: 0,
      filesAnalyzed: files.length,
      linesChanged: 0,
    },
    target: {
      additions: 0,
      authors: 1,
      commits,
      deletions: 0,
      id: TARGET,
      kind: "package",
      linesChanged: 0,
    },
  };
}

function hotspot(file: string, fanIn: number): FileHotspot {
  return {
    architecture: {
      moduleGravity: {
        fanIn,
        fanOut: 1,
        transitiveDependencies: 1,
        transitiveDependents: fanIn,
      },
      package: TARGET,
    },
    complexity: {
      controlFlowDecisions: { max: 8, total: 20 },
      expressionDecisions: { max: 0, total: 0 },
      functions: 3,
      nesting: { max: 3 },
      statements: { max: 20, total: 40 },
    },
    evolution: {
      additions: 0,
      commitPercentile: 0.95,
      commits: 12,
      deletions: 0,
      lineChurnPercentile: 0.9,
      linesChanged: 0,
    },
    file,
    kind: "source",
    rank: {
      commitPercentile: 0.95,
      complexityPercentile: 1,
      lineChurnPercentile: 0.9,
    },
    signals: ["frequent-change", "branch-heavy"],
  };
}

function hotspotReport(files: FileHotspot[]): HotspotReport {
  return {
    available: true,
    files,
    summary: {
      eligibleSourceFiles: 10,
      filesAboveCommitP90: files.length,
      filesAboveCommitP95: files.length,
      hotspotShare: files.length / 10,
      hotspots: files.length,
    },
    target: TARGET,
    windowDays: 365,
  };
}

function pair(
  left: string,
  right: string,
  coChangeCommits: number,
  staticRelation: StaticRelation,
  conditionals: [number, number] = [0.8, 0.8],
  staticPath: StaticPathRelation = resolvePair(staticRelation)
): PackageChangeCoupling {
  return {
    coChangeCommits,
    jaccard: 0.5,
    left,
    leftCommits: Math.round(coChangeCommits / conditionals[0]),
    leftConditional: conditionals[0],
    right,
    rightCommits: Math.round(coChangeCommits / conditionals[1]),
    rightConditional: conditionals[1],
    staticPath,
    staticRelation,
  };
}

function resolvePair(
  staticRelation: StaticRelation
): "none" | "unmeasured" | "direct" {
  if (staticRelation === "unmeasured") {
    return "unmeasured";
  }
  if (staticRelation === "none") {
    return "none";
  }
  return "direct";
}

function filePair(
  left: string,
  right: string,
  coChangeCommits: number,
  staticRelation: StaticRelation,
  conditionals?: [number, number],
  staticPath?: StaticPathRelation,
  context: CouplingContext = "source-source"
): FileChangeCouplingPair {
  const owner = (file: string) => {
    if (file.startsWith("packages/a/")) {
      return TARGET;
    }
    if (file.startsWith("apps/studio/")) {
      return STUDIO;
    }
    return "@fixture/b";
  };
  const leftPackage = owner(left);
  const rightPackage = owner(right);
  return {
    ...pair(
      left,
      right,
      coChangeCommits,
      staticRelation,
      conditionals,
      staticPath
    ),
    context,
    leftPackage,
    rightPackage,
    scope: leftPackage === rightPackage ? "same-package" : "cross-package",
  };
}

function couplingReport(
  filePairs: FileChangeCouplingPair[] = [],
  packagePairs: PackageChangeCoupling[] = []
): ChangeCouplingReport {
  return {
    available: true,
    filePairs,
    files: [],
    history: {
      commitsConsidered: 500,
      commitsExcluded: 10,
      observedFilePairs: 1000,
      oversized: { configSweepMinPackages: 5, maxCodeFilesPerCommit: 40 },
      windowDays: 365,
    },
    packagePairs,
    summary: {
      crossPackagePairs: filePairs.filter((p) => p.scope === "cross-package")
        .length,
      filePairs: filePairs.length,
      filePairsWithoutStaticEdge: 0,
      filePairsWithoutStaticPath: 0,
      packagePairs: packagePairs.length,
      packagePairsWithoutStaticEdge: 0,
      samePackagePairs: filePairs.filter((p) => p.scope === "same-package")
        .length,
    },
    target: TARGET,
  };
}

interface RadiusOptions {
  boundaryCrossing?: number;
  combinations?: PackageCombination[];
  commits: number;
  commitsWithStudio?: number;
  crossPackage?: number;
  packagesP50?: number;
}

function radiusReport(options: RadiusOptions): ChangeRadiusReport {
  const cross = options.crossPackage ?? 0;
  const boundary = options.boundaryCrossing ?? cross;
  const withStudio = options.commitsWithStudio ?? 0;
  return {
    available: true,
    commits: Array.from({ length: options.commits }, (_, i) => ({
      additions: 1,
      composition: "source-dominant" as const,
      deletions: 0,
      files: 2,
      filesByKind: { config: 0, other: 0, source: 2, story: 0, test: 0 },
      hash: `c${i}`,
      linesChanged: 1,
      packageBoundariesCrossed: 0,
      packageSet: i < withStudio ? [TARGET, STUDIO] : [TARGET],
      packages: i < withStudio ? 2 : 1,
      sourceFiles: 2,
      targetFileShare: 0.5,
      targetFiles: 1,
      targetPackages: 1,
      timestamp: "2026-05-01T00:00:00.000Z",
    })),
    history: {
      commitsEligible: options.commits,
      commitsExcluded: 1,
      commitsObserved: options.commits + 1,
      oversized: { configSweepMinPackages: 5, maxCodeFilesPerCommit: 40 },
      windowDays: 365,
    },
    summary: {
      boundaries: dist(0),
      boundaryCrossingCommits: boundary,
      boundaryCrossingRate:
        options.commits === 0 ? 0 : boundary / options.commits,
      commits: options.commits,
      crossPackageCommits: cross,
      crossPackageRate: options.commits === 0 ? 0 : cross / options.commits,
      files: dist(3),
      packageCombinations: options.combinations ?? [],
      packages: dist(options.packagesP50 ?? 1),
      singlePackageCommits: options.commits - cross,
      sourceFiles: dist(2),
    },
    target: TARGET,
  };
}

function pressure(
  kind: StructuralPressureKind,
  evidence: PressureEvidence[] = [
    { dimension: "gravity", metric: "fanOut", value: 6 },
    { dimension: "boundary", metric: "outgoingImportSites", value: 200 },
  ],
  anchored = false
): StructuralPressureSignal {
  return {
    dimensions: ["gravity", "boundary"],
    evidence,
    id: `${kind}:${TARGET}`,
    intent: anchored
      ? { anchored: true, anchorReason: "intentional subsystem" }
      : { anchored: false },
    kind,
    scope: { id: TARGET, type: "package" },
  };
}

const LEAF: ArchitecturalProfileSignalResult = {
  evidence: [
    { metric: "fanIn", value: 1 },
    { metric: "fanOut", value: 2 },
  ],
  signal: "leaf-like",
};

interface SourceOptions {
  churn?: FileChurn[];
  coupling?: ChangeCouplingReport;
  functions?: string[];
  hotspots?: FileHotspot[];
  incomingSeams?: string[];
  modules?: DependencyGravity[];
  pressures?: StructuralPressureSignal[];
  primaryConsumer?: string;
  profileSignals?: ArchitecturalProfileSignalResult[];
  radius?: ChangeRadiusReport;
}

function sourceOf(options: SourceOptions = {}): EvolutionaryPressureSource {
  const modules = options.modules ?? [
    gravity(A_INDEX, "module", 3, 2),
    gravity(A_CORE, "module", 1, 0),
    gravity(A_STORE, "module", 1, 0),
  ];
  const radius = options.radius ?? radiusReport({ commits: 50 });
  const primary = options.primaryConsumer;
  return {
    architecturalProfile: {
      target: {
        complexity: {
          controlFlowDecisions: dist(),
          decisions: dist(),
          functionsAnalyzed: 0,
          nesting: dist(),
          parameters: { max: 0, p90: 0 },
          statements: { max: 0, p90: 0 },
        },
        gravity: {
          cycleMember: false,
          dependencyReach: 0.2,
          dependentReach: 0.1,
          downstreamDepth: 1,
          fanIn: 1,
          fanOut: 2,
          transitiveDependencies: 2,
          transitiveDependents: 1,
          upstreamDepth: 1,
        },
        intent: { anchored: false },
        node: { id: TARGET, kind: "package" },
        signals: options.profileSignals ?? [],
        surface: {
          averageSymbolDistribution: 1,
          consumerPackages: 1,
          declaredSurfaceRatio: 0.5,
          exportUtilization: 0.4,
          externallyUsedSymbols: 2,
          externalSurfaceRatio: 0.2,
          moduleOnlyExports: 0,
          packagePublicSymbols: 5,
          totalSymbols: 10,
          unusedExternalExports: 3,
        },
      },
    },
    boundaryInteractions: {
      incoming: (options.incomingSeams ?? []).map((module, i) => ({
        breadth: { destinationModules: 1, sourceModules: 1 },
        concentration: { destinationModuleShare: 1, sourceModuleShare: 1 },
        destinationModules: [
          {
            importSites: 10 - i,
            module,
            moduleEdges: 1,
            references: 10,
            share: 1,
            symbols: 1,
          },
        ],
        from: STUDIO,
        importSites: 10 - i,
        moduleEdges: 1,
        sourceModules: [],
        surfaceCoverage: 0.2,
        symbols: {
          distinct: 1,
          packagePublic: 1,
          references: 10,
          referencesPerSymbol: 10,
        },
        to: TARGET,
        usage: {
          bothSymbols: 0,
          namespace: "value",
          typeOnlySymbols: 0,
          valueOnlySymbols: 1,
        },
      })),
      outgoing: [],
      summary: {
        incoming: {
          importSites: 10,
          moduleEdges: 1,
          packages: 1,
          references: 10,
          symbols: 1,
        },
        outgoing: {
          importSites: 0,
          moduleEdges: 0,
          packages: 0,
          references: null,
          symbols: 0,
        },
        throughPaths: 0,
      },
      target: TARGET,
    },
    changeCoupling: options.coupling ?? couplingReport(),
    changeRadius: radius,
    churn: churnReport(
      options.churn ?? [churnFile(A_INDEX, 3, 0.5)],
      radius.available ? radius.history.commitsEligible + 2 : 0
    ),
    dependencies: {
      consumerPackages: primary === undefined ? 0 : 1,
      dependencyPackages: 0,
      incoming: [],
      outgoing: [],
      ...(primary !== undefined && {
        primaryConsumer: {
          package: primary,
          referenceShare: 0.9,
          surfaceShare: 0.9,
        },
      }),
      averageSymbolDistribution: 1,
      shapeSignals: [],
    },
    dependencyGravity: {
      incomingConcentration: [],
      internalEdges: [],
      modules,
      outgoingConcentration: [],
      population: { modules: 100, packages: 10 },
      target: gravity(TARGET, "package", 1, 2),
    },
    hotspots: hotspotReport(options.hotspots ?? []),
    localComplexity: {
      functions: (options.functions ?? []).map((file, i) => ({
        exported: false,
        file,
        id: `${file}#L${i + 1}C1#fn`,
        kind: "function",
        line: i + 1,
        metrics: {
          async: { async: false, awaits: 0, generator: false, yields: 0 },
          callbacks: { maxDepth: 0, nestedFunctions: 0 },
          decisions: {
            cases: 0,
            catches: 0,
            controlFlow: 0,
            defaults: 0,
            elseIfs: 0,
            expression: 0,
            ifs: 0,
            logical: 0,
            loops: 0,
            switches: 0,
            ternaries: 0,
            total: 0,
          },
          exceptions: { catches: 0, finals: 0, tries: 0 },
          exits: { breaks: 0, continues: 0, returns: 1, throws: 0 },
          loops: {
            doWhile: 0,
            for: 0,
            forIn: 0,
            forOf: 0,
            total: 0,
            while: 0,
          },
          nesting: { max: 0 },
          parameters: {
            boolean: 0,
            defaulted: 0,
            optional: 0,
            rest: 0,
            total: 0,
          },
          statements: 1,
        },
        name: "fn",
        packagePublic: false,
      })),
      summary: {
        controlFlowDecisions: aggregate(),
        decisions: aggregate(),
        functionsAnalyzed: 0,
        nesting: aggregate(),
        parameters: aggregate(),
        statements: aggregate(),
      },
    },
    structuralPressure: {
      boundaries: [],
      signals: options.pressures ?? [],
      target: TARGET,
    },
    target: { boundaryType: "package", name: TARGET, path: "packages/a" },
  };
}

function analyze(
  options: SourceOptions = {},
  config: AnalysisConfig = ANALYSIS_CONFIG
) {
  const report = analyzeEvolutionaryPressure(sourceOf(options), config);
  if (!report.available) {
    throw new Error(report.reason);
  }
  return report;
}

const wideRadius = radiusReport({
  boundaryCrossing: 70,
  combinations: [{ commits: 60, packages: [TARGET, STUDIO] }],
  commits: 100,
  commitsWithStudio: 60,
  crossPackage: 75,
  packagesP50: 2,
});

describe("reinforced pressures", () => {
  it("reinforces integration pressure from wide radius and connected coupling", () => {
    const report = analyze({
      coupling: couplingReport([], [pair(TARGET, STUDIO, 60, "right-to-left")]),
      pressures: [pressure("integration-pressure")],
      radius: wideRadius,
    });
    expect(report.historicalSupport).toBe("adequate");
    expect(report.staticOnly).toEqual([]);
    const [signal] = report.reinforced;
    expect(signal).toMatchObject({
      kind: "reinforced-integration-pressure",
      staticSignal: "integration-pressure",
      support: { commits: 100 },
    });
    expect(signal?.staticEvidence).toHaveLength(2);
    expect(signal?.evolutionaryEvidence).toEqual(
      expect.arrayContaining([
        { dimension: "radius", metric: "crossPackageRate", value: 0.75 },
        { dimension: "radius", metric: "boundaryCrossingRate", value: 0.7 },
        {
          dimension: "coupling",
          metric: "packageCoChangeCommits",
          subject: STUDIO,
          value: 60,
        },
      ])
    );
  });

  it("leaves integration pressure static-only when change stays local", () => {
    const report = analyze({
      pressures: [pressure("integration-pressure")],
      radius: radiusReport({ commits: 100, crossPackage: 20 }),
    });
    expect(report.reinforced).toEqual([]);
    const [entry] = report.staticOnly;
    expect(entry).toMatchObject({
      staticSignal: "integration-pressure",
      status: "static-only",
    });
    expect(entry?.evolutionaryEvidence).toContainEqual({
      dimension: "radius",
      metric: "crossPackageRate",
      value: 0.2,
    });
  });

  it("reinforces surface pressure through the primary consumer's recurrence", () => {
    const report = analyze({
      pressures: [pressure("surface-pressure")],
      primaryConsumer: STUDIO,
      radius: wideRadius,
    });
    expect(report.reinforced.map((s) => s.kind)).toEqual([
      "reinforced-surface-pressure",
    ]);
    expect(report.reinforced[0]?.evolutionaryEvidence).toEqual([
      {
        dimension: "radius",
        metric: "commitsWithPrimaryConsumer",
        subject: STUDIO,
        value: 60,
      },
      {
        dimension: "radius",
        metric: "combinationCommits",
        subject: STUDIO,
        value: 60,
      },
    ]);
  });

  it("reinforces centralization pressure only through a temporally active seam", () => {
    const report = analyze({
      churn: [churnFile(A_INDEX, 12, 0.95), churnFile(A_CORE, 1, 0.1)],
      incomingSeams: [A_INDEX, A_CORE],
      pressures: [pressure("centralization-pressure")],
    });
    const [signal] = report.reinforced;
    expect(signal?.kind).toBe("reinforced-centralization-pressure");
    expect(signal?.evolutionaryEvidence).toEqual(
      expect.arrayContaining([
        {
          dimension: "coupling",
          metric: "seamReinforced",
          subject: A_INDEX,
          value: true,
        },
        {
          dimension: "coupling",
          metric: "seamReinforced",
          subject: A_CORE,
          value: false,
        },
      ])
    );
    const quiet = analyze({
      churn: [churnFile(A_CORE, 1, 0.1)],
      incomingSeams: [A_CORE],
      pressures: [pressure("centralization-pressure")],
    });
    expect(quiet.staticOnly[0]?.status).toBe("static-only");
  });

  it("reinforces several pressures at once without overwriting", () => {
    const report = analyze({
      hotspots: [hotspot(A_INDEX, 25)],
      pressures: [
        pressure("integration-pressure"),
        pressure("internal-structure-pressure"),
      ],
      radius: wideRadius,
    });
    expect(report.reinforced.map((s) => s.kind)).toEqual([
      "reinforced-integration-pressure",
      "reinforced-internal-structure-pressure",
    ]);
  });

  it("carries anchor intent on reinforced signals", () => {
    const report = analyze({
      pressures: [pressure("integration-pressure", undefined, true)],
      radius: wideRadius,
    });
    expect(report.reinforced[0]?.intent).toEqual({
      anchored: true,
      anchorReason: "intentional subsystem",
    });
  });
});

describe("support gate", () => {
  it("marks every pressure insufficient-history under tiny support", () => {
    const report = analyze({
      churn: [churnFile(A_INDEX, 3, 0.99)],
      coupling: couplingReport([], [pair(TARGET, STUDIO, 12, "none")]),
      modules: [gravity(A_INDEX, "module", 40, 0)],
      pressures: [pressure("integration-pressure")],
      profileSignals: [LEAF],
      radius: radiusReport({ commits: 3, crossPackage: 3, packagesP50: 4 }),
    });
    expect(report.historicalSupport).toBe("insufficient");
    expect(report.reinforced).toEqual([]);
    expect(report.tensions).toEqual([]);
    expect(report.staticOnly).toEqual([
      expect.objectContaining({
        staticSignal: "integration-pressure",
        status: "insufficient-history",
      }),
    ]);
    expect(report.hotStructuralHubs).toHaveLength(1);
  });

  it("responds to injected thresholds deterministically", () => {
    const options: SourceOptions = {
      pressures: [pressure("integration-pressure")],
      radius: radiusReport({ commits: 8, crossPackage: 5, packagesP50: 2 }),
    };
    expect(analyze(options).historicalSupport).toBe("insufficient");
    const relaxed: AnalysisConfig = {
      ...ANALYSIS_CONFIG,
      evolutionaryPressure: {
        ...ANALYSIS_CONFIG.evolutionaryPressure,
        support: { minCommits: 5 },
      },
    };
    expect(analyze(options, relaxed).reinforced).toHaveLength(1);
    const strict: AnalysisConfig = {
      ...relaxed,
      evolutionaryPressure: {
        ...relaxed.evolutionaryPressure,
        integration: { minBoundaryCrossingRate: 0.9 },
      },
    };
    expect(analyze(options, strict).reinforced).toEqual([]);
    expect(analyze(options, strict).staticOnly[0]?.status).toBe("static-only");
  });
});

describe("tensions", () => {
  it("flags a static leaf that history couples to another package", () => {
    const report = analyze({
      coupling: couplingReport([], [pair(TARGET, STUDIO, 60, "right-to-left")]),
      profileSignals: [LEAF],
      radius: wideRadius,
    });
    const [tension] = report.tensions;
    expect(tension).toMatchObject({
      kind: "static-leaf-temporal-coupling",
      support: { commits: 60 },
    });
    expect(tension?.evidence.static).toEqual([
      { dimension: "gravity", metric: "fanIn", value: 1 },
      { dimension: "gravity", metric: "fanOut", value: 2 },
    ]);
    expect(tension?.summary).toContain(STUDIO);
    expect(
      analyze({ profileSignals: [LEAF], radius: radiusReport({ commits: 50 }) })
        .tensions
    ).toEqual([]);
  });

  it("names the dominant combination over a weaker strong pair", () => {
    const [tension] = analyze({
      coupling: couplingReport(
        [],
        [pair("@fixture/hooks", TARGET, 11, "left-to-right", [0.6, 0.05])]
      ),
      profileSignals: [LEAF],
      radius: wideRadius,
    }).tensions;
    expect(tension?.summary).toContain(STUDIO);
    expect(tension?.support).toEqual({ commits: 60 });
  });

  it("flags static pressure with quiet history", () => {
    const report = analyze({
      pressures: [pressure("surface-pressure")],
      primaryConsumer: STUDIO,
      radius: radiusReport({ commits: 40, crossPackage: 4 }),
    });
    expect(report.staticOnly[0]?.status).toBe("static-only");
    expect(report.tensions).toEqual([
      expect.objectContaining({
        kind: "static-pressure-low-evolution",
        support: { commits: 40 },
      }),
    ]);
  });

  it("flags strong file coupling with no static path", () => {
    const report = analyze({
      coupling: couplingReport([
        filePair(A_STORE, B_MEMORY, 13, "none", [0.87, 0.87]),
      ]),
    });
    expect(report.tensions).toEqual([
      expect.objectContaining({
        kind: "temporal-coupling-without-static-path",
        support: { commits: 13 },
      }),
    ]);
  });

  it("treats barrel-mediated (indirect) coupling as explained, not a tension", () => {
    const report = analyze({
      coupling: couplingReport([
        filePair(A_CORE, S_MAIN, 8, "none", undefined, "indirect"),
      ]),
    });
    expect(report.tensions).toEqual([]);
  });

  it("does not raise no-path tensions for test, story, or config companions", () => {
    const report = analyze({
      coupling: couplingReport([
        filePair(
          A_CORE,
          "packages/a/test/core.test.ts",
          9,
          "none",
          undefined,
          "none",
          "source-test"
        ),
        filePair(
          A_CORE,
          "packages/a/src/stories/core.stories.tsx",
          9,
          "none",
          undefined,
          "none",
          "story-related"
        ),
        filePair(
          "packages/a/package.json",
          "apps/studio/package.json",
          9,
          "unmeasured",
          undefined,
          "unmeasured",
          "config-config"
        ),
      ]),
    });
    expect(report.tensions).toEqual([]);
  });
});

describe("evidence", () => {
  it("recognizes a hot structural hub that is not a hotspot", () => {
    const options: SourceOptions = {
      churn: [churnFile(A_INDEX, 62, 0.999)],
      functions: [],
      modules: [gravity(A_INDEX, "module", 109, 0)],
    };
    const source = sourceOf(options);
    expect(analyzeHotspots(source)).toMatchObject({
      available: true,
      files: [],
    });
    expect(analyze(options).hotStructuralHubs).toEqual([
      {
        commitPercentile: 0.999,
        commits: 62,
        fanIn: 109,
        fanOut: 0,
        file: A_INDEX,
        functions: 0,
      },
    ]);
    expect(
      analyze({ ...options, modules: [gravity(A_INDEX, "module", 5, 0)] })
        .hotStructuralHubs
    ).toEqual([]);
  });

  it("carries the module role on a hub and ignores non-source kinds", () => {
    const barrel: DependencyGravity = {
      ...gravity(A_INDEX, "module", 109, 0),
      role: {
        entrypoint: true,
        kind: "aggregator",
        ownDeclarations: 0,
        reExports: 20,
      },
    };
    const report = analyze({
      churn: [churnFile(A_INDEX, 62, 0.999)],
      modules: [barrel],
    });
    expect(report.hotStructuralHubs).toEqual([
      expect.objectContaining({ file: A_INDEX, role: "aggregator" }),
    ]);
    const fixtures = "packages/a/src/stories/fixtures.ts";
    expect(
      analyze({
        churn: [{ ...churnFile(fixtures, 30, 0.99), kind: "story" }],
        modules: [gravity(fixtures, "module", 28, 0)],
      }).hotStructuralHubs
    ).toEqual([]);
  });

  it("does not let a hot barrel alone reinforce internal-structure pressure", () => {
    const barrel: DependencyGravity = {
      ...gravity(A_INDEX, "module", 109, 0),
      role: {
        entrypoint: true,
        kind: "aggregator",
        ownDeclarations: 0,
        reExports: 20,
      },
    };
    const report = analyze({
      churn: [churnFile(A_INDEX, 62, 0.999)],
      modules: [barrel],
      pressures: [pressure("internal-structure-pressure")],
    });
    expect(report.hotStructuralHubs).toHaveLength(1);
    expect(report.reinforced).toEqual([]);
    expect(report.staticOnly[0]?.status).toBe("static-only");
  });

  it("lets a hot hub reinforce internal-structure pressure", () => {
    const report = analyze({
      churn: [churnFile(A_INDEX, 62, 0.999)],
      modules: [gravity(A_INDEX, "module", 109, 0)],
      pressures: [pressure("internal-structure-pressure")],
    });
    expect(report.reinforced[0]?.evolutionaryEvidence).toEqual(
      expect.arrayContaining([
        { dimension: "churn", metric: "hotStructuralHubs", value: 1 },
        {
          dimension: "churn",
          metric: "commits",
          subject: A_INDEX,
          value: 62,
        },
      ])
    );
  });

  it("splits cross-package spread into edge-following and edge-less", () => {
    const report = analyze({
      radius: radiusReport({
        boundaryCrossing: 72,
        commits: 100,
        crossPackage: 75,
      }),
    });
    expect(report.spread).toEqual({
      boundaryCrossingRate: 0.72,
      crossPackageRate: 0.75,
      edgeLessSpreadCommits: 3,
      edgeLessSpreadRate: 0.03,
    });
  });

  it("reports support counts from the underlying sections", () => {
    const report = analyze({
      coupling: couplingReport(
        [filePair(A_CORE, S_MAIN, 8, "left-to-right")],
        [pair(TARGET, STUDIO, 60, "right-to-left")]
      ),
      hotspots: [hotspot(A_INDEX, 3)],
      radius: wideRadius,
    });
    expect(report.support).toEqual({
      eligibleRadiusCommits: 100,
      fileCouplingPairs: 1,
      hotspots: 1,
      packageCouplingPairs: 1,
    });
  });

  it("propagates unavailable history", () => {
    const source = sourceOf();
    const report = analyzeEvolutionaryPressure({
      ...source,
      churn: { available: false, reason: "not-git-repository" },
    });
    expect(report).toEqual({
      available: false,
      reason: "not-git-repository",
    });
  });
});

describe("rendering", () => {
  it("renders static, evolution, reinforced, and tension sections", () => {
    const source = sourceOf({
      coupling: couplingReport(
        [],
        [pair(TARGET, STUDIO, 60, "right-to-left", [0.6, 0.2])]
      ),
      pressures: [pressure("surface-pressure")],
      primaryConsumer: STUDIO,
      profileSignals: [LEAF],
      radius: wideRadius,
    });
    const text = renderEvolution({
      ...source,
      evolutionaryPressure: analyzeEvolutionaryPressure(source),
    });
    expect(text).toContain("STATIC\n  surface-pressure\n  leaf-like");
    expect(text).toContain(
      "100 eligible commits · historical support adequate"
    );
    expect(text).toContain(
      "75.0% cross-package · 70.0% boundary-crossing · 5.0% edge-less spread (5 commits)"
    );
    expect(text).toContain("REINFORCED\n\n  SURFACE PRESSURE");
    expect(text).toContain("TENSIONS (1)\n\n  STATIC LEAF TEMPORAL COUPLING");
    expect(text).not.toContain("COUPLING PATHS");
    expect(text).not.toMatch(expectedTextPattern);
  });

  it("renders insufficient history without conclusions", () => {
    const source = sourceOf({
      pressures: [pressure("integration-pressure")],
      radius: radiusReport({ commits: 3, crossPackage: 3 }),
    });
    const text = renderEvolution({
      ...source,
      evolutionaryPressure: analyzeEvolutionaryPressure(source),
    });
    expect(text).toContain("historical support insufficient");
    expect(text).toContain("INTEGRATION PRESSURE · insufficient history");
    expect(text).not.toContain("REINFORCED");
  });
});
