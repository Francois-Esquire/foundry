import { describe, expect, it } from "vitest";
import type {
  ConceptBehavioralLocalitySource,
  LocalityFacts,
} from "../../src/lib/concept-locality";
import {
  analyzeConceptBehavioralLocality,
  assessLocality,
} from "../../src/lib/concept-locality";
import type { AnalysisConfig } from "../../src/lib/config";

import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type {
  ChurnFileKind,
  ConceptBehaviorParticipant,
  ConceptFamily,
  ConceptOwnershipAnalysis,
  FileChangeCouplingPair,
  FileHotspot,
} from "../../src/lib/types";

const A = "packages/a/src/index.ts";
const A2 = "packages/a/src/extra.ts";
const B = "packages/b/src/index.ts";
const C = "packages/c/src/index.ts";
const HELPER = "packages/a/test/helper.ts";

function participant(
  file: string,
  symbol: string,
  role: ConceptBehaviorParticipant["role"] = "contract"
): ConceptBehaviorParticipant {
  const pkg = `@t/${file.split("/")[1] ?? ""}`;
  const kind: ChurnFileKind = file.includes("/test/") ? "test" : "source";
  return { file, kind, member: "function", package: pkg, role, symbol };
}

function family(participants: ConceptBehaviorParticipant[]): ConceptFamily {
  const modules = [...new Set(participants.map((item) => item.file))];
  return {
    distribution: {
      moduleCount: modules.length,
      modules,
      packageCount: 1,
      packagePublicRepresentations: 0,
      packages: ["@t/a"],
      references: participants.length,
    },
    distributionAnalysis: {
      boundaries: {
        moduleCount: modules.length,
        packageSpan: 0,
        referencePackages: ["@t/a"],
        representationPackages: ["@t/a"],
        seedPackage: "@t/a",
      },
      packages: [],
      references: {
        byModule: modules.map((module) => ({
          module,
          package: "@t/a",
          references: 1,
          share: 1 / modules.length,
        })),
        byPackage: [],
        packageCount: 1,
        primaryPackage: "@t/a",
        primaryShare: 1,
        total: participants.length,
      },
      relationships: { byKind: [] },
      representations: {
        implementationModules: 0,
        implementationPackages: 0,
        moduleCount: 1,
        packageCount: 1,
        packages: [{ kinds: ["seed"], package: "@t/a", representations: 1 }],
        primaryPackage: "@t/a",
        primaryShare: 1,
        total: 1,
      },
      seed: {
        id: `${A}#Thing`,
        kind: "interface",
        name: "Thing",
        package: "@t/a",
      },
      shapes: ["local"],
    },
    evidence: [],
    relationships: {
      alias: 0,
      constructs: 0,
      extends: 0,
      implements: 0,
      "parameter-type": participants.length,
      "property-type": 0,
      "return-type": 0,
      "type-reference": 0,
    },
    representations: [],
    seed: {
      declaration: { file: A, package: "@t/a" },
      id: `${A}#Thing`,
      kind: "interface",
      name: "Thing",
      surface: {
        externallyUsed: true,
        moduleExported: true,
        packagePublic: true,
      },
    },
  };
}

function ownership(
  participants: ConceptBehaviorParticipant[],
  center: Partial<ConceptOwnershipAnalysis["center"]> = {}
): ConceptOwnershipAnalysis {
  return {
    alignment: "aligned",
    behavior: {
      byPackage: [],
      contractTotal: participants.length,
      participants,
      total: participants.length,
    },
    candidates: [],
    cautions: [],
    center: { implementations: [], ...center },
    concept: {
      file: A,
      id: `${A}#Thing`,
      inTarget: true,
      kind: "interface",
      name: "Thing",
      package: "@t/a",
    },
    overlap: [],
    representationKinds: [],
    tensions: [],
  };
}

function pair(
  left: string,
  right: string,
  coChangeCommits: number,
  context: FileChangeCouplingPair["context"] = "source-source"
): FileChangeCouplingPair {
  return {
    coChangeCommits,
    context,
    jaccard: coChangeCommits / (coChangeCommits + 3),
    lastCoChangedAt: "2027-01-01T00:00:00Z",
    left,
    leftCommits: coChangeCommits + 2,
    leftConditional: coChangeCommits / (coChangeCommits + 2),
    leftPackage: `@t/${left.split("/")[1] ?? ""}`,
    right,
    rightCommits: coChangeCommits + 1,
    rightConditional: coChangeCommits / (coChangeCommits + 1),
    rightPackage: `@t/${right.split("/")[1] ?? ""}`,
    scope:
      left.split("/")[1] === right.split("/")[1]
        ? "same-package"
        : "cross-package",
    staticPath: "indirect",
    staticRelation: "none",
  };
}

function hotspot(
  file: string,
  commits: number,
  commitPercentile: number
): FileHotspot {
  return {
    complexity: {
      controlFlowDecisions: { max: 0, total: 0 },
      expressionDecisions: { max: 0, total: 0 },
      functions: 1,
      nesting: { max: 0 },
      statements: { max: 0, total: 0 },
    },
    evolution: {
      additions: 0,
      commitPercentile,
      commits,
      deletions: 0,
      lineChurnPercentile: 0,
      linesChanged: 0,
    },
    file,
    kind: "source",
    rank: { commitPercentile, complexityPercentile: 0, lineChurnPercentile: 0 },
    signals: ["frequent-change"],
  };
}

function source(
  participants: ConceptBehaviorParticipant[],
  history: { pairs?: FileChangeCouplingPair[]; hotspots?: FileHotspot[] } = {},
  center: Partial<ConceptOwnershipAnalysis["center"]> = {}
): ConceptBehavioralLocalitySource {
  const target = { boundaryType: "package" as const, path: "packages/a" };
  const withHistory =
    history.pairs !== undefined || history.hotspots !== undefined;
  return {
    boundary: { packageName: "@t/a", relPath: target.path },
    changeCoupling: withHistory
      ? {
          available: true,
          filePairs: history.pairs ?? [],
          files: [],
          history: {
            commitsConsidered: 10,
            commitsExcluded: 0,
            observedFilePairs: history.pairs?.length ?? 0,
            oversized: { configSweepMinPackages: 3, maxCodeFilesPerCommit: 30 },
            windowDays: null,
          },
          packagePairs: [],
          summary: {
            crossPackagePairs: 0,
            filePairs: history.pairs?.length ?? 0,
            filePairsWithoutStaticEdge: 0,
            filePairsWithoutStaticPath: 0,
            packagePairs: 0,
            packagePairsWithoutStaticEdge: 0,
            samePackagePairs: 0,
          },
          target: "@t/a",
        }
      : { available: false, reason: "not-git-repository" },
    conceptInventory: {
      families: [family(participants)],
      summary: {
        aliases: 0,
        crossPackageFamilies: 0,
        distributedFamilies: 0,
        families: 1,
        implementations: 0,
        seeds: 1,
      },
      target: "@t/a",
    },
    conceptOverlap: {
      candidates: [],
      generation: {
        candidates: 0,
        indexedDeclarations: 1,
        pairsCompared: 0,
        pairsGenerated: {
          conversion: 0,
          name: 0,
          property: 0,
          temporal: 0,
          total: 0,
        },
        seeds: 1,
      },
      summary: {
        bidirectionalConversionPairs: 0,
        candidates: 0,
        conversionPairs: 0,
        crossPackageCandidates: 0,
        nearEquivalent: 0,
        projectionLike: 0,
        structurallyOverlapping: 0,
      },
      target: "@t/a",
    },
    conceptOwnership: {
      concepts: [ownership(participants, center)],
      summary: {
        aligned: 1,
        analyzed: 1,
        distributed: 0,
        divergent: 0,
        insufficientEvidence: 0,
        tensions: 0,
      },
      target: "@t/a",
    },
    dependencyGravity: {
      incomingConcentration: [],
      internalEdges: [],
      modules: [],
      outgoingConcentration: [],
      population: { modules: 5, packages: 3 },
      target: {
        cycle: { member: false, size: 0 },
        depth: { downstream: 0, upstream: 0 },
        direct: { fanIn: 0, fanOut: 0 },
        node: { id: "@t/a", kind: "package" },
        reach: { dependencies: 0, dependents: 0 },
        transitive: { dependencies: 0, dependents: 0 },
      },
    },
    graph: {
      edges: [
        { fromFile: A2, toFile: A },
        { fromFile: B, toFile: A },
        { fromFile: C, toFile: B },
        { fromFile: HELPER, toFile: A },
      ],
      modules: [A, A2, B, C, HELPER],
      owners: {
        [A]: "@t/a",
        [A2]: "@t/a",
        [B]: "@t/b",
        [C]: "@t/c",
        [HELPER]: "@t/a",
      },
    },
    hotspots: withHistory
      ? {
          available: true,
          files: history.hotspots ?? [],
          summary: {
            eligibleSourceFiles: 5,
            filesAboveCommitP90: 0,
            filesAboveCommitP95: 0,
            hotspotShare: 0,
            hotspots: history.hotspots?.length ?? 0,
          },
          target: "@t/a",
          windowDays: null,
        }
      : { available: false, reason: "not-git-repository" },
  };
}

function facts(overrides: Partial<LocalityFacts>): LocalityFacts {
  const byModule = overrides.behavior?.byModule ?? [];
  return {
    anchored: false,
    behavior: {
      byModule,
      byPackage: [],
      other: 0,
      source: 0,
      story: 0,
      test: 0,
      total: 0,
    },
    changeSurface: {
      converterModules: 0,
      hotspotModules: 0,
      implementationModules: 0,
      packages: 1,
      sourceModules: byModule.length,
      stronglyCoupledBehaviorModules: 0,
    },
    concentration: { primaryModuleShare: null, primaryPackageShare: null },
    concept: {
      file: A,
      id: `${A}#Thing`,
      inTarget: true,
      kind: "interface",
      name: "Thing",
      package: "@t/a",
    },
    contractWithoutImplementations: false,
    distribution: { representation: { share: null }, usage: { share: null } },
    foreignSourceBehavior: false,
    halo: { modules: 1, packages: 1, references: 1 },
    span: {
      boundaryEdges: [],
      moduleCount: byModule.length,
      packageBoundaryCount: 0,
      packageCount: 1,
      sourceModuleCount: byModule.length,
      sourcePackageCount: 1,
    },
    traversal: {
      centerDistances: [],
      disconnectedModules: 0,
      disconnectedPackagePairs: 0,
      maxModuleDistance: null,
      maxPackageDistance: null,
      moduleDistances: [],
      origin: { module: A, package: "@t/a" },
      packageDistances: [],
      participatingModules: [],
      participatingPackages: ["@t/a"],
    },
    ...overrides,
  };
}

function moduleRow(
  module: string,
  behaviors: number,
  kind: ChurnFileKind = "source",
  implementation = 0
) {
  return {
    behaviors,
    contractBehaviors: behaviors - implementation,
    conversionBehaviors: 0,
    implementationBehaviors: implementation,
    kind,
    module,
    package: `@t/${module.split("/")[1] ?? ""}`,
  };
}

describe("shape rules", () => {
  it("reads no source behavior as insufficient, or behavior-light when references are broad", () => {
    expect(assessLocality(facts({})).shape.primary).toBe(
      "insufficient-evidence"
    );
    const broad = { modules: 12, packages: 4, references: 30 };
    expect(assessLocality(facts({ halo: broad })).shape.primary).toBe(
      "behavior-light"
    );
    const classSeed = facts({ halo: broad });
    classSeed.concept = { ...classSeed.concept, kind: "class" };
    expect(assessLocality(classSeed).shape.primary).toBe(
      "insufficient-evidence"
    );
  });

  it("reads little behavior beside broad references as behavior-light, not local", () => {
    const light = assessLocality(
      facts({
        behavior: {
          byModule: [moduleRow(A, 2)],
          byPackage: [],
          other: 0,
          source: 2,
          story: 0,
          test: 0,
          total: 2,
        },
        halo: { modules: 11, packages: 5, references: 40 },
      })
    );
    expect(light.shape.primary).toBe("behavior-light");
    expect(light.cautions).toEqual([]);
  });

  it("notes sparse source behavior only where the shape claims spread", () => {
    const two = {
      byModule: [moduleRow(A, 1), moduleRow(B, 1)],
      byPackage: [],
      other: 0,
      source: 2,
      story: 0,
      test: 0,
      total: 2,
    };
    const spread = assessLocality(
      facts({
        behavior: two,
        span: {
          boundaryEdges: [],
          moduleCount: 2,
          packageBoundaryCount: 0,
          packageCount: 2,
          sourceModuleCount: 2,
          sourcePackageCount: 2,
        },
      })
    );
    expect(spread.shape.primary).toBe("cross-package-localized");
    expect(spread.cautions.map((item) => item.kind)).toEqual([
      "sparse-source-behavior",
    ]);
    const local = assessLocality(
      facts({ behavior: { ...two, byModule: [moduleRow(A, 2)] } })
    );
    expect(local.shape.primary).toBe("local");
    expect(local.cautions).toEqual([]);
  });

  it("splits one package into local and single-package-distributed by module count", () => {
    const config: AnalysisConfig = {
      ...ANALYSIS_CONFIG,
      behavioralLocality: {
        ...ANALYSIS_CONFIG.behavioralLocality,
        singlePackageDistributed: { minModules: 4 },
      },
    };
    const three = facts({
      behavior: {
        byModule: [
          moduleRow(A, 2),
          moduleRow(A2, 2),
          moduleRow("packages/a/src/x.ts", 2),
        ],
        byPackage: [],
        other: 0,
        source: 6,
        story: 0,
        test: 0,
        total: 6,
      },
    });
    expect(assessLocality(three).shape.primary).toBe(
      "single-package-distributed"
    );
    expect(assessLocality(three, config).shape.primary).toBe("local");
  });

  it("needs modules plus breadth for cross-package-distributed", () => {
    const base = facts({
      behavior: {
        byModule: [
          moduleRow(A, 1),
          moduleRow(A2, 1),
          moduleRow(B, 2),
          moduleRow("packages/b/src/x.ts", 2),
          moduleRow("packages/b/src/y.ts", 1),
          moduleRow("packages/b/src/z.ts", 1),
        ],
        byPackage: [],
        other: 0,
        source: 8,
        story: 0,
        test: 0,
        total: 8,
      },
      span: {
        boundaryEdges: [{ from: "@t/b", to: "@t/a" }],
        moduleCount: 6,
        packageBoundaryCount: 1,
        packageCount: 2,
        sourceModuleCount: 6,
        sourcePackageCount: 2,
      },
    });
    expect(assessLocality(base).shape.primary).toBe("cross-package-localized");
    const far = facts({
      ...base,
      traversal: { ...base.traversal, maxModuleDistance: 3 },
    });
    expect(assessLocality(far).shape.primary).toBe("cross-package-distributed");
    const apart = facts({
      ...base,
      traversal: { ...base.traversal, disconnectedPackagePairs: 1 },
    });
    expect(assessLocality(apart).shape.primary).toBe(
      "cross-package-distributed"
    );
    expect(assessLocality(apart).cautions.map((item) => item.kind)).toContain(
      "disconnected-static-path"
    );
  });

  it("adds parallel-implementations from source implementation modules only", () => {
    const rows = [moduleRow(A, 2, "source", 2), moduleRow(B, 2, "source", 2)];
    const both = assessLocality(
      facts({
        behavior: {
          byModule: rows,
          byPackage: [],
          other: 0,
          source: 4,
          story: 0,
          test: 0,
          total: 4,
        },
        span: {
          boundaryEdges: [],
          moduleCount: 2,
          packageBoundaryCount: 0,
          packageCount: 2,
          sourceModuleCount: 2,
          sourcePackageCount: 2,
        },
      })
    );
    expect(both.shape.modifiers).toEqual(["parallel-implementations"]);
    const testFake = assessLocality(
      facts({
        behavior: {
          byModule: [
            moduleRow(A, 2, "source", 2),
            moduleRow(HELPER, 2, "test", 2),
          ],
          byPackage: [],
          other: 0,
          source: 2,
          story: 0,
          test: 2,
          total: 4,
        },
      })
    );
    expect(testFake.shape.modifiers).toEqual([]);
  });

  it("notes structural conformance and test-heavy behavior as cautions", () => {
    const item = assessLocality(
      facts({
        behavior: {
          byModule: [moduleRow(A, 3), moduleRow(HELPER, 10, "test")],
          byPackage: [],
          other: 0,
          source: 3,
          story: 0,
          test: 10,
          total: 13,
        },
        contractWithoutImplementations: true,
      })
    );
    expect(item.shape.primary).toBe("local");
    expect(item.cautions.map((caution) => caution.kind)).toEqual([
      "structural-conformance-unobserved",
      "test-heavy-behavior",
    ]);
  });
});

describe("temporal context", () => {
  const participants = [
    participant(A, "make"),
    participant(A2, "read"),
    participant(B, "store"),
  ];

  it("keeps a hotspot behavior module with its rank", () => {
    const [thing] = analyzeConceptBehavioralLocality(
      source(participants, { hotspots: [hotspot(A2, 14, 0.96)] })
    ).concepts;
    expect(thing?.temporal?.hotspots).toEqual([
      { commitPercentile: 0.96, commits: 14, module: A2 },
    ]);
    expect(thing?.changeSurface.hotspotModules).toBe(1);
  });

  it("reads a strong pair between two behavior modules as internal coupling", () => {
    const [thing] = analyzeConceptBehavioralLocality(
      source(participants, { pairs: [pair(A2, B, 9)] })
    ).concepts;
    expect(thing?.temporal?.internalCouplings).toEqual([
      {
        aggregatorMediated: false,
        coChangeCommits: 9,
        context: "source-source",
        jaccard: 0.75,
        left: A2,
        leftConditional: 9 / 11,
        right: B,
        rightConditional: 0.9,
        staticPath: "indirect",
      },
    ]);
    expect(thing?.changeSurface.stronglyCoupledBehaviorModules).toBe(2);
    expect(thing?.temporal?.externalCompanions).toEqual([]);
  });

  it("keeps an external companion outside the behavior map", () => {
    const [thing] = analyzeConceptBehavioralLocality(
      source(participants, {
        pairs: [pair(B, C, 6), pair(A, HELPER, 4, "source-test")],
      })
    ).concepts;
    expect(thing?.temporal?.externalCompanions).toEqual([
      {
        coChangeCommits: 6,
        context: "source-source",
        external: C,
        externalPackage: "@t/c",
        module: B,
      },
      {
        coChangeCommits: 4,
        context: "source-test",
        external: HELPER,
        externalPackage: "@t/a",
        module: A,
      },
    ]);
    expect(thing?.behavior.byModule.map((row) => row.module)).toEqual([
      A2,
      A,
      B,
    ]);
    expect(thing?.span.sourceModuleCount).toBe(3);
    expect(thing?.changeSurface.stronglyCoupledBehaviorModules).toBe(0);
  });

  it("omits temporal context without history", () => {
    const [thing] = analyzeConceptBehavioralLocality(
      source(participants)
    ).concepts;
    expect(thing?.temporal).toBeUndefined();
    expect(thing?.cautions.map((item) => item.kind)).not.toContain(
      "target-scoped-history"
    );
  });
});

describe("traversal and independence", () => {
  const participants = [
    participant(A, "make"),
    participant(B, "store"),
    participant(C, "serve"),
  ];

  it("measures A → B → C as distance 2 in the importing direction", () => {
    const [thing] = analyzeConceptBehavioralLocality(
      source(participants)
    ).concepts;
    expect(thing?.traversal.moduleDistances).toEqual([
      { from: A, inward: 1, to: B, viaAggregator: false },
      { from: A, inward: 2, to: C, viaAggregator: false },
    ]);
    expect(thing?.traversal.centerDistances).toEqual([
      { from: "@t/a", inward: 1, to: "@t/b" },
      { from: "@t/a", inward: 2, to: "@t/c" },
    ]);
    expect(thing?.traversal.packageDistances).toEqual([
      { from: "@t/a", inward: 1, to: "@t/b" },
      { from: "@t/a", inward: 2, to: "@t/c" },
      { from: "@t/b", inward: 1, to: "@t/c" },
    ]);
    expect(thing?.span.boundaryEdges).toEqual([
      { from: "@t/b", to: "@t/a" },
      { from: "@t/c", to: "@t/b" },
    ]);
    expect(thing?.traversal.maxModuleDistance).toBe(2);
  });

  it("tags a converter once, however many partners it converts to", () => {
    const withConversions = source(participants);
    const left = ownership(participants).concept;
    const conversion = (to: string) => ({
      file: B,
      from: `${A}#Thing`,
      function: "store",
      to,
    });
    withConversions.conceptOverlap.candidates.push(
      {
        bidirectionalConversion: false,
        conversions: [conversion(`${B}#Stored`)],
        crossPackage: true,
        dimensions: ["conversion"],
        evidence: [],
        left,
        right: {
          file: B,
          id: `${B}#Stored`,
          inTarget: false,
          kind: "interface",
          name: "Stored",
          package: "@t/b",
        },
        shapes: ["conversion-pair"],
      },
      {
        bidirectionalConversion: false,
        conversions: [
          conversion(`${B}#Row`),
          { ...conversion(`${B}#Row`), function: "load" },
        ],
        crossPackage: true,
        dimensions: ["conversion"],
        evidence: [],
        left,
        right: {
          file: B,
          id: `${B}#Row`,
          inTarget: false,
          kind: "interface",
          name: "Row",
          package: "@t/b",
        },
        shapes: ["conversion-pair"],
      }
    );
    const [thing] = analyzeConceptBehavioralLocality(withConversions).concepts;
    // `store` was a V7.3 participant and is tagged once; `load` was not and joins once.
    expect(thing?.behavior.total).toBe(4);
    expect(
      thing?.behavior.byModule.find((row) => row.module === B)
    ).toMatchObject({
      behaviors: 2,
      contractBehaviors: 2,
      conversionBehaviors: 2,
    });
    expect(thing?.changeSurface.converterModules).toBe(1);
  });

  it("does not move behavioral participants when ownership centers change", () => {
    const [plain] = analyzeConceptBehavioralLocality(
      source(participants)
    ).concepts;
    const [recentered] = analyzeConceptBehavioralLocality(
      source(
        participants,
        {},
        { behavior: "@t/c", implementations: ["@t/b"], usage: "@t/c" }
      )
    ).concepts;
    expect(recentered?.behavior).toEqual(plain?.behavior);
    expect(recentered?.traversal).toEqual(plain?.traversal);
    expect(recentered?.shape).toEqual(plain?.shape);
  });

  it("orders modules, packages, and distances deterministically", () => {
    const reversed = [...participants].reverse();
    const [forward] = analyzeConceptBehavioralLocality(
      source(participants)
    ).concepts;
    const [backward] = analyzeConceptBehavioralLocality(
      source(reversed)
    ).concepts;
    expect(backward).toEqual(forward);
    expect(forward?.behavior.byModule.map((row) => row.module)).toEqual([
      A,
      B,
      C,
    ]);
  });
});
