import { describe, expect, it } from "vitest";
import {
  analyzeConceptDistribution,
  attachConceptDistribution,
} from "../../src/lib/concept-distribution";
import type { AnalysisConfig } from "../../src/lib/config";

import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type {
  ChangeCouplingReport,
  ChurnReport,
  ConceptEvidence,
  ConceptFamily,
  ConceptInventoryReport,
  ConceptRelationshipKind,
  ConceptRepresentation,
  ConceptRepresentationRelationship,
  FileChangeCouplingPair,
  FileHotspot,
  HotspotReport,
  SymbolKind,
} from "../../src/lib/types";

const RELATIONSHIP_KINDS: ConceptRelationshipKind[] = [
  "implements",
  "extends",
  "alias",
  "type-reference",
  "parameter-type",
  "return-type",
  "property-type",
  "constructs",
];

const REPRESENTATION_OF: Record<
  ConceptRelationshipKind,
  ConceptRepresentationRelationship
> = {
  alias: "alias",
  constructs: "other",
  extends: "extension",
  implements: "implementation",
  "parameter-type": "type-user",
  "property-type": "type-user",
  "return-type": "factory",
  "type-reference": "type-user",
};

interface Use {
  /** `name@package/file` — omit the name for module-level code. */
  at: string;
  kind: ConceptRelationshipKind;
  symbolKind?: SymbolKind;
  times?: number;
}

const PACKAGE_OF: Record<string, string> = {
  cli: "@t/cli",
  core: "@t/core",
  db: "@t/db",
  studio: "@t/studio",
};

function fileOf(shorthand: string): { package: string; file: string } {
  const [pkg, file] = shorthand.split("/");
  const name = PACKAGE_OF[pkg ?? ""];
  if (name === undefined || file === undefined) {
    throw new Error(`bad shorthand: ${shorthand}`);
  }
  return { file: `packages/${pkg}/src/${file}.ts`, package: name };
}

/** Build a V7.0 family the way `analyzeConceptInventory` would roll it up. */
function familyOf(
  name: string,
  declaredAt: string,
  uses: Use[]
): ConceptFamily {
  const declaration = fileOf(declaredAt);
  const id = `${declaration.file}#${name}`;
  const evidence: ConceptEvidence[] = [
    { kind: "declaration", target: id, ...declaration, line: 1 },
  ];
  let line = 10;
  for (const use of uses) {
    const [source, location] = use.at.includes("@")
      ? use.at.split("@")
      : [undefined, use.at];
    const where = fileOf(location);
    for (let i = 0; i < (use.times ?? 1); i += 1) {
      line += 1;
      evidence.push({
        kind: use.kind,
        ...(source !== undefined && {
          source: {
            kind: use.symbolKind ?? "function",
            name: source,
            symbolId: `${where.file}#${source}`,
          },
        }),
        target: id,
        ...where,
        line,
      });
    }
  }
  const relationships = Object.fromEntries(
    RELATIONSHIP_KINDS.map((kind) => [kind, 0])
  ) as Record<ConceptRelationshipKind, number>;
  const representations = new Map<string, ConceptRepresentation>();
  const packages = new Set<string>();
  const modules = new Set<string>();
  let references = 0;
  for (const item of evidence) {
    packages.add(item.package);
    modules.add(item.file);
    if (item.kind === "declaration") {
      continue;
    }
    references += 1;
    relationships[item.kind] += 1;
    if (item.source === undefined) {
      continue;
    }
    const relationship = REPRESENTATION_OF[item.kind];
    const key = `${item.source.symbolId}#${relationship}`;
    const existing = representations.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    representations.set(key, {
      file: item.file,
      kind: item.source.kind,
      name: item.source.name,
      occurrences: 1,
      package: item.package,
      relationship,
      symbolId: item.source.symbolId,
    });
  }
  return {
    distribution: {
      moduleCount: modules.size,
      modules: [...modules].sort(),
      packageCount: packages.size,
      packagePublicRepresentations: 0,
      packages: [...packages].sort(),
      references,
    },
    evidence,
    relationships,
    representations: [...representations.values()],
    seed: {
      declaration,
      id,
      kind: "interface",
      name,
      surface: {
        externallyUsed: true,
        moduleExported: true,
        packagePublic: true,
      },
    },
  };
}

function inventoryOf(...families: ConceptFamily[]): ConceptInventoryReport {
  return {
    families,
    summary: {
      aliases: 0,
      crossPackageFamilies: 0,
      distributedFamilies: 0,
      families: families.length,
      implementations: 0,
      seeds: families.length,
    },
    target: "@t/core",
  };
}

const noHistory = {
  changeCoupling: { available: false, reason: "not-git-repository" },
  churn: { available: false, reason: "not-git-repository" },
  hotspots: { available: false, reason: "not-git-repository" },
} satisfies Parameters<typeof analyzeConceptDistribution>[1];

function pair(
  left: string,
  right: string,
  coChangeCommits: number
): FileChangeCouplingPair {
  const a = fileOf(left);
  const b = fileOf(right);
  const [l, r] = a.file < b.file ? [a, b] : [b, a];
  return {
    coChangeCommits,
    context: "source-source",
    jaccard: coChangeCommits / (coChangeCommits + 2),
    left: l.file,
    leftCommits: coChangeCommits + 1,
    leftConditional: coChangeCommits / (coChangeCommits + 1),
    leftPackage: l.package,
    right: r.file,
    rightCommits: coChangeCommits + 1,
    rightConditional: coChangeCommits / (coChangeCommits + 1),
    rightPackage: r.package,
    scope: l.package === r.package ? "same-package" : "cross-package",
    staticPath: "indirect",
    staticRelation: "none",
  };
}

function couplingReport(
  filePairs: FileChangeCouplingPair[]
): ChangeCouplingReport {
  return {
    available: true,
    filePairs,
    files: [],
    history: {
      commitsConsidered: 100,
      commitsExcluded: 0,
      observedFilePairs: filePairs.length,
      oversized: { configSweepMinPackages: 5, maxCodeFilesPerCommit: 40 },
      windowDays: 365,
    },
    packagePairs: [],
    summary: {
      crossPackagePairs: 0,
      filePairs: filePairs.length,
      filePairsWithoutStaticEdge: 0,
      filePairsWithoutStaticPath: 0,
      packagePairs: 0,
      packagePairsWithoutStaticEdge: 0,
      samePackagePairs: 0,
    },
    target: "@t/core",
  };
}

function hotspot(shorthand: string): FileHotspot {
  return {
    complexity: {
      controlFlowDecisions: { max: 8, total: 12 },
      expressionDecisions: { max: 0, total: 0 },
      functions: 3,
      nesting: { max: 3 },
      statements: { max: 20, total: 40 },
    },
    evolution: {
      additions: 100,
      commitPercentile: 0.95,
      commits: 20,
      deletions: 50,
      lineChurnPercentile: 0.9,
      linesChanged: 150,
    },
    file: fileOf(shorthand).file,
    kind: "source",
    rank: {
      commitPercentile: 0.95,
      complexityPercentile: 0.9,
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
    target: "@t/core",
    windowDays: 365,
  };
}

function churnReport(files: string[]): ChurnReport {
  const dist = () => ({ max: 0, p50: 0, p90: 0, p95: 0 });
  const distributions = {
    authorsPerFile: dist(),
    commitsPerFile: dist(),
    daysSinceLastChange: dist(),
    linesChangedPerFile: dist(),
  };
  const totals = { commits: 0, files: 0, linesChanged: 0 };
  return {
    available: true,
    distributions,
    files: files.map((file) => ({
      additions: 5,
      authors: 1,
      commits: 5,
      deletions: 0,
      file: fileOf(file).file,
      kind: "source" as const,
      linesChanged: 5,
      rank: { commitPercentile: 0.5, lineChurnPercentile: 0.5 },
    })),
    history: {
      analyzedAt: "2026-06-01T00:00:00.000Z",
      commitsAnalyzed: 100,
      historyComplete: true,
      windowDays: 365,
    },
    repository: { commits: 100, distributions, filesAnalyzed: 10 },
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
      id: "@t/core",
      kind: "package",
      linesChanged: 0,
    },
  };
}

const store = familyOf("Store", "core/store", [
  { at: "InMemoryStore@core/memory", kind: "implements", symbolKind: "class" },
  { at: "SqliteStore@db/sqlite", kind: "implements", symbolKind: "class" },
  { at: "run@studio/app", kind: "parameter-type", times: 3 },
  { at: "createStore@core/memory", kind: "return-type" },
  { at: "core/memory", kind: "type-reference" },
]);

function analysis(family: ConceptFamily, config?: AnalysisConfig) {
  const [result] = analyzeConceptDistribution(
    inventoryOf(family),
    noHistory,
    config
  ).families;
  if (result === undefined) {
    throw new Error("no analysis");
  }
  return result;
}

describe("shapes", () => {
  it("stays local when representations and references share one package", () => {
    const local = familyOf("Local", "core/a", [
      { at: "Options@core/a", kind: "property-type", symbolKind: "interface" },
      { at: "use@core/b", kind: "parameter-type" },
    ]);
    const result = analysis(local);
    expect(result.shapes).toEqual(["local"]);
    expect(result.representations.packageCount).toBe(1);
    expect(result.boundaries.packageSpan).toBe(0);
  });

  it("marks a family cross-package when an implementation lives elsewhere", () => {
    const family = familyOf("Port", "core/port", [
      { at: "Adapter@db/adapter", kind: "implements", symbolKind: "class" },
    ]);
    expect(analysis(family).shapes).toEqual(["cross-package"]);
  });

  it("marks implementation-split with the implementation package count", () => {
    const family = familyOf("Port", "core/port", [
      { at: "DbAdapter@db/adapter", kind: "implements", symbolKind: "class" },
      { at: "CliAdapter@cli/adapter", kind: "implements", symbolKind: "class" },
    ]);
    const result = analysis(family);
    expect(result.shapes).toEqual(["cross-package", "implementation-split"]);
    expect(result.representations.implementationPackages).toBe(2);
    expect(result.representations.implementationModules).toBe(2);
  });

  it("fires reference-distributed under an injected policy", () => {
    const family = familyOf("Id", "core/ids", [
      { at: "a@core/ids", kind: "parameter-type", times: 2 },
      { at: "b@db/x", kind: "parameter-type", times: 2 },
      { at: "c@studio/y", kind: "parameter-type", times: 2 },
    ]);
    const config: AnalysisConfig = {
      ...ANALYSIS_CONFIG,
      conceptDistribution: {
        ...ANALYSIS_CONFIG.conceptDistribution,
        referenceDistributed: { maxPrimaryReferenceShare: 0.4, minPackages: 3 },
      },
    };
    expect(analysis(family, config).shapes).toContain("reference-distributed");
  });

  it("does not fire reference-distributed when one package dominates", () => {
    const family = familyOf("Id", "core/ids", [
      { at: "a@core/ids", kind: "parameter-type", times: 19 },
      { at: "b@db/x", kind: "parameter-type" },
      { at: "c@studio/y", kind: "parameter-type" },
    ]);
    const result = analysis(family);
    expect(result.references.packageCount).toBe(3);
    expect(result.references.primaryShare).toBeCloseTo(19 / 21);
    expect(result.shapes).not.toContain("reference-distributed");
  });

  it("fires representation-concentrated only with references in several packages", () => {
    const concentrated = familyOf("Env", "core/env", [
      { at: "LocalEnv@core/env", kind: "extends", symbolKind: "interface" },
      { at: "RemoteEnv@core/env", kind: "extends", symbolKind: "interface" },
      { at: "createEnv@core/env", kind: "return-type" },
      { at: "db/x", kind: "parameter-type" },
    ]);
    const result = analysis(concentrated);
    expect(result.representations.total).toBe(4);
    expect(result.representations.primaryShare).toBe(1);
    expect(result.shapes).toContain("representation-concentrated");

    const localOnly = familyOf("Env", "core/env", [
      { at: "LocalEnv@core/env", kind: "extends", symbolKind: "interface" },
      { at: "RemoteEnv@core/env", kind: "extends", symbolKind: "interface" },
      { at: "createEnv@core/env", kind: "return-type" },
    ]);
    expect(analysis(localOnly).shapes).toEqual(["local"]);
  });
});

describe("representation distribution", () => {
  it("counts the seed and each distinct symbol once, with explicit kinds", () => {
    const { representations } = analysis(store);
    expect(representations).toEqual({
      implementationModules: 2,
      implementationPackages: 2,
      moduleCount: 4,
      packageCount: 3,
      packages: [
        {
          kinds: ["seed", "implementation", "factory"],
          package: "@t/core",
          representations: 3,
        },
        { kinds: ["implementation"], package: "@t/db", representations: 1 },
        { kinds: ["type-user"], package: "@t/studio", representations: 1 },
      ],
      primaryPackage: "@t/core",
      primaryShare: 0.6,
      total: 5,
    });
  });

  it("counts a symbol attached by two relationships once", () => {
    const family = familyOf("Store", "core/store", [
      { at: "load@core/store", kind: "parameter-type" },
      { at: "load@core/store", kind: "return-type" },
    ]);
    expect(family.representations).toHaveLength(2);
    expect(analysis(family).representations.total).toBe(2);
  });
});

describe("reference distribution", () => {
  it("computes exact package and module shares from evidence", () => {
    const { references } = analysis(store);
    expect(references.total).toBe(store.distribution.references);
    expect(references.total).toBe(7);
    expect(references.byPackage).toEqual([
      { modules: 1, package: "@t/core", references: 3, share: 3 / 7 },
      { modules: 1, package: "@t/studio", references: 3, share: 3 / 7 },
      { modules: 1, package: "@t/db", references: 1, share: 1 / 7 },
    ]);
    expect(references.byModule[0]).toEqual({
      module: "packages/core/src/memory.ts",
      package: "@t/core",
      references: 3,
      share: 3 / 7,
    });
    // core and studio tie at 3; the lexically first package is primary.
    expect(references.primaryPackage).toBe("@t/core");
    expect(references.primaryShare).toBe(3 / 7);
  });

  it("reports a null primary share without references", () => {
    const { references } = analysis(familyOf("Lonely", "core/a", []));
    expect(references).toEqual({
      byModule: [],
      byPackage: [],
      packageCount: 0,
      primaryShare: null,
      total: 0,
    });
  });
});

describe("relationships, boundaries, and package matrix", () => {
  it("distributes each relationship kind by package", () => {
    expect(analysis(store).relationships.byKind).toEqual([
      {
        packages: [
          { count: 1, package: "@t/core" },
          { count: 1, package: "@t/db" },
        ],
        relationship: "implements",
        total: 2,
      },
      {
        packages: [{ count: 1, package: "@t/core" }],
        relationship: "type-reference",
        total: 1,
      },
      {
        packages: [{ count: 3, package: "@t/studio" }],
        relationship: "parameter-type",
        total: 3,
      },
      {
        packages: [{ count: 1, package: "@t/core" }],
        relationship: "return-type",
        total: 1,
      },
    ]);
  });

  it("separates the seed package from representation and reference packages", () => {
    expect(analysis(store).boundaries).toEqual({
      moduleCount: 4,
      packageSpan: 2,
      referencePackages: ["@t/core", "@t/db", "@t/studio"],
      representationPackages: ["@t/core", "@t/db", "@t/studio"],
      seedPackage: "@t/core",
    });
  });

  it("builds the package presence matrix with exact counts", () => {
    expect(analysis(store).packages).toEqual([
      {
        implementations: 1,
        package: "@t/core",
        references: 3,
        relationshipKinds: ["implements", "type-reference", "return-type"],
        representations: 3,
        seed: true,
      },
      {
        implementations: 0,
        package: "@t/studio",
        references: 3,
        relationshipKinds: ["parameter-type"],
        representations: 1,
        seed: false,
      },
      {
        implementations: 1,
        package: "@t/db",
        references: 1,
        relationshipKinds: ["implements"],
        representations: 1,
        seed: false,
      },
    ]);
  });
});

describe("temporal annotation", () => {
  const history = {
    changeCoupling: couplingReport([
      pair("core/memory", "db/sqlite", 13),
      pair("db/sqlite", "studio/unrelated", 20),
    ]),
    churn: churnReport(["core/store", "core/memory"]),
    hotspots: hotspotReport([hotspot("db/sqlite")]),
  };

  it("attaches existing V6 coupling between member files", () => {
    const [result] = analyzeConceptDistribution(
      inventoryOf(store),
      history
    ).families;
    expect(result?.temporal).toEqual({
      hotspotRepresentations: ["SqliteStore"],
      representedFilesWithChurn: 2,
      strongMemberCouplings: [
        {
          coChangeCommits: 13,
          context: "source-source",
          jaccard: 13 / 15,
          left: {
            file: "packages/core/src/memory.ts",
            representations: ["InMemoryStore", "createStore"],
          },
          leftConditional: 13 / 14,
          right: {
            file: "packages/db/src/sqlite.ts",
            representations: ["SqliteStore"],
          },
          rightConditional: 13 / 14,
          staticPath: "indirect",
        },
      ],
    });
  });

  it("never lets a strong pair with an outside file change the family", () => {
    const before = JSON.stringify(store.representations);
    const report = analyzeConceptDistribution(inventoryOf(store), history);
    const [result] = report.families;
    expect(JSON.stringify(store.representations)).toBe(before);
    expect(result?.representations.total).toBe(5);
    expect(
      result?.temporal?.strongMemberCouplings.some((coupling) =>
        [coupling.left.file, coupling.right.file].includes(
          "packages/studio/src/unrelated.ts"
        )
      )
    ).toBe(false);
    expect(report.summary.temporallyCoupled).toBe(1);
  });

  it("omits temporal context without history", () => {
    expect(analysis(store).temporal).toBeUndefined();
    expect(
      analyzeConceptDistribution(inventoryOf(store), noHistory).summary
        .temporallyCoupled
    ).toBe(0);
  });
});

describe("report and attachment", () => {
  it("summarizes shapes and attaches analyses to families in order", () => {
    const local = familyOf("Local", "core/a", []);
    const inventory = inventoryOf(store, local);
    const report = analyzeConceptDistribution(inventory, noHistory);
    // Store: 3 reference packages, primary share 3/7 ≤ 0.5 → reference-distributed.
    expect(report.summary).toEqual({
      crossPackage: 1,
      families: 2,
      implementationSplit: 1,
      local: 1,
      referenceDistributed: 1,
      representationConcentrated: 0,
      temporallyCoupled: 0,
    });
    attachConceptDistribution(inventory, report);
    expect(inventory.families[0]?.distributionAnalysis?.seed.name).toBe(
      "Store"
    );
    expect(inventory.families[1]?.distributionAnalysis?.shapes).toEqual([
      "local",
    ]);
    expect(inventory.distribution).toEqual(report.summary);
  });

  it("orders packages by references, then representations, then name", () => {
    const family = familyOf("T", "core/t", [
      { at: "a@db/x", kind: "parameter-type" },
      { at: "b@cli/y", kind: "parameter-type" },
      { at: "C@cli/y", kind: "property-type", symbolKind: "interface" },
    ]);
    const { packages } = analysis(family);
    expect(packages.map((row) => row.package)).toEqual([
      "@t/cli",
      "@t/db",
      "@t/core",
    ]);
  });
});
