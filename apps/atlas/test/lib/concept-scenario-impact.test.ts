import { describe, expect, it } from "vitest";
import type { RecenteringBoundaryUse } from "../../src/lib/concept-recentering";
import type { ScenarioImpactFacts } from "../../src/lib/concept-scenario-impact";
import { simulateScenarioImpact } from "../../src/lib/concept-scenario-impact";
import type {
  ScenarioBehaviorPackage,
  ScenarioFacts,
} from "../../src/lib/concept-scenarios";
import { generateRecenteringScenarios } from "../../src/lib/concept-scenarios";
import type { AnalysisConfig } from "../../src/lib/config";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type {
  MiscenteredConceptFinding,
  MiscenteringSignal,
  RecenteringScenario,
  RecenteringScenarioKind,
  ScenarioImpactAnalysis,
} from "../../src/lib/types";

const A = "@t/a";
const B = "@t/b";
const C = "@t/c";
const SEED = "packages/a/src/thing.ts";
const A_IMPL = "packages/a/src/impl.ts";
const B_IMPL = "packages/b/src/impl.ts";
const B_WIRE = "packages/b/src/wire.ts";
const C_IMPL = "packages/c/src/impl.ts";

function finding(
  signal: MiscenteringSignal,
  centers: { target: string; gravity: number }[],
  cautions: MiscenteredConceptFinding["cautions"] = []
): MiscenteredConceptFinding {
  return {
    anchored: false,
    cautions,
    concept: {
      file: SEED,
      id: "concept:a:Thing",
      inTarget: true,
      kind: "interface",
      name: "Thing",
      package: A,
    },
    declaredHome: { anchored: false, module: SEED, package: A },
    evidence: [],
    evidenceConfidence: 0.5,
    gravityFamilies: ["behavioral-locality"],
    id: "concept:a:Thing",
    mismatch: 0,
    observedCenters: centers.map((center) => ({
      ...center,
      anchored: false,
      shares: {},
    })),
    signal,
    summary: "",
    supportingFamilies: ["behavioral-locality"],
    weights: { "behavioral-locality": 1 },
  };
}

function behavior(
  rows: {
    package: string;
    governing?: number;
    adapters?: number;
    conversions?: number;
    construction?: number;
  }[]
): ScenarioBehaviorPackage[] {
  const total = rows.reduce((sum, row) => sum + (row.governing ?? 0), 0);
  return rows.map((row) => ({
    adapters: row.adapters ?? 0,
    construction: row.construction ?? 0,
    conversions: row.conversions ?? 0,
    governing: row.governing ?? 0,
    governingShare: total === 0 ? 0 : (row.governing ?? 0) / total,
    package: row.package,
  }));
}

function shares(rows: Record<string, number>) {
  const total = Object.values(rows).reduce((sum, value) => sum + value, 0);
  return Object.entries(rows).map(([pkg, value]) => ({
    package: pkg,
    share: value / total,
  }));
}

function scenarioFacts(overrides: Partial<ScenarioFacts> = {}): ScenarioFacts {
  return {
    anchors: [],
    behavior: behavior([
      { governing: 2, package: A },
      { governing: 8, package: B },
    ]),
    boundaries: [],
    consumptionHeavy: false,
    finding: finding("external-gravity", [
      { gravity: 0.8, target: B },
      { gravity: 0.2, target: A },
    ]),
    home: A,
    implementationCenters: [],
    publicContract: true,
    referenceShares: shares({ [A]: 1, [B]: 1, [C]: 1 }),
    representationShares: shares({ [A]: 3, [B]: 7 }),
    supportingFamilies: [],
    unobservedConformance: false,
    ...overrides,
  };
}

/** B imports A across an edge that carries only the concept: exclusive at module granularity. */
function boundary(
  overrides: Partial<RecenteringBoundaryUse> = {}
): RecenteringBoundaryUse {
  return {
    conceptImportedModules: [SEED],
    conceptImportedSitesByModule: [{ importSites: 10, module: SEED }],
    conceptImportingModules: [B_IMPL],
    conceptImportSitesByModule: [{ importSites: 10, module: B_IMPL }],
    destinationModules: 1,
    foreignPackage: B,
    from: B,
    importSites: 10,
    sourceModules: 1,
    to: A,
    ...overrides,
  };
}

function facts(
  overrides: Partial<ScenarioImpactFacts> = {},
  scenario: Partial<ScenarioFacts> = {}
): ScenarioImpactFacts {
  return {
    boundaries: [
      boundary(),
      boundary({
        conceptImportedSitesByModule: [{ importSites: 2, module: SEED }],
        conceptImportingModules: [],
        conceptImportSitesByModule: [],
        foreignPackage: C,
        from: C,
        importSites: 2,
      }),
    ],
    couplings: [],
    disconnectedPairs: [],
    edges: [{ from: B, to: A }],
    historyAvailable: true,
    hotspotModules: [],
    locality: {
      disconnectedModules: 0,
      disconnectedPackagePairs: 0,
      maxModuleDistance: 1,
      modifiers: [],
      primaryPackageShare: 0.8,
      shape: "cross-package-localized",
      sourceBehaviors: 10,
      sourceModules: 2,
      sourcePackages: 2,
      topTwoModuleShare: 1,
    },
    modules: [
      {
        conversion: 0,
        implementation: 0,
        module: SEED,
        package: A,
        return: 2,
        weak: 0,
      },
      {
        conversion: 0,
        implementation: 0,
        module: B_IMPL,
        package: B,
        return: 8,
        weak: 0,
      },
    ],
    scenario: scenarioFacts(scenario),
    seed: { externallyUsed: true, module: SEED, packagePublic: true },
    seedImporters: [
      { importSites: 10, package: B },
      { importSites: 2, package: C },
    ],
    weakByPackage: [],
    ...overrides,
  };
}

function simulate(
  source: ScenarioImpactFacts,
  kind: RecenteringScenarioKind,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ScenarioImpactAnalysis {
  const { scenarios } = generateRecenteringScenarios(source.scenario, config);
  const scenario = scenarios.find((item) => item.kind === kind);
  if (scenario === undefined) {
    throw new Error(`no ${kind} scenario generated`);
  }
  return simulateScenarioImpact(source, scenario, config);
}

function kinds(item: ScenarioImpactAnalysis): string[] {
  return item.changes.map((change) => change.kind);
}

describe("baseline", () => {
  it("keeps the current arrangement with zero placement delta and every current fact", () => {
    const item = simulate(facts(), "preserve-current");
    expect(item.baseline).toEqual(item.proposed);
    expect(item.changes).toEqual([]);
    expect(item.impact.locality.sourcePackageCount).toEqual({
      certainty: "certain",
      current: 2,
      delta: 0,
      predicted: 2,
    });
    expect(item.impact.locality.shapeTransition).toEqual({
      certainty: "certain",
      from: "cross-package-localized",
      to: "cross-package-localized",
    });
    expect(item.impact.boundaries.preserved).toEqual([
      "@t/b → @t/a",
      "@t/c → @t/a",
    ]);
    expect(item.impact.dependency.removed).toEqual([]);
    expect(item.impact.dependency.added).toEqual([]);
    expect(item.preserved.map((row) => row.kind)).toEqual([
      "semantic-center",
      "public-contract",
      "consumer-boundary",
    ]);
    expect(item.status).toBe("simulated");
  });
});

describe("semantic rehome", () => {
  it("moves the contract with certainty, flags the surface, leaves the behavior span alone, and leaves consumers unresolved", () => {
    const item = simulate(facts(), "rehome-semantic-center");
    expect(kinds(item)).toEqual([
      "semantic-center-change",
      "boundary-elimination",
      "boundary-addition",
      "dependency-elimination",
      "dependency-addition",
      "surface-relocation",
    ]);
    expect(item.changes[0]).toMatchObject({
      certainty: "certain",
      from: A,
      to: B,
    });
    expect(item.impact.locality.sourcePackageCount.delta).toBe(0);
    expect(item.impact.behavior.governingBehaviorRelocated).toBe(0);
    expect(item.impact.surface).toMatchObject({
      consumers: { impact: "unresolved", packages: [B, C] },
      packagePublicContractRelocated: true,
      publicExposureAdded: [B],
      publicExposureRemoved: [A],
      reexportRequirement: "unknown",
    });
    expect(item.uncertainties.map((row) => row.kind)).toContain(
      "consumer-compatibility-unknown"
    );
    expect(item.uncertainties.map((row) => row.kind)).toContain(
      "surface-transition-unspecified"
    );
  });

  it("never assumes a re-export and leaves a plain consumer's edge uncertain", () => {
    const item = simulate(facts(), "rehome-semantic-center");
    const consumer = item.impact.boundaries.current.find(
      (state) => state.from === C
    );
    expect(consumer?.outcome).toBe("uncertain");
    expect(JSON.stringify(item)).not.toMatch(/re-?export(s|ed)? from/i);
  });

  it("adds the edge the old home would need to reach its contract", () => {
    const item = simulate(facts(), "rehome-semantic-center");
    expect(item.impact.boundaries.added).toEqual(["@t/a → @t/b"]);
    expect(item.impact.dependency.added.map((edge) => edge.from)).toEqual([A]);
    expect(item.impact.boundaries.predicted).toContainEqual(
      expect.objectContaining({
        certainty: "conditional",
        edge: "@t/a → @t/b",
        outcome: "added",
      })
    );
  });
});

describe("behavior rehome and consolidation", () => {
  it("decreases the source behavior package count and keeps the semantic center", () => {
    const item = simulate(facts(), "rehome-behavior");
    expect(item.impact.locality.sourcePackageCount).toMatchObject({
      certainty: "certain",
      current: 2,
      delta: -1,
      predicted: 1,
    });
    expect(item.impact.behavior).toMatchObject({
      certainty: "certain",
      governingBehaviorPreserved: 2,
      governingBehaviorRelocated: 8,
      packagesRemoved: [B],
    });
    expect(item.preserved).toContainEqual({
      detail: A,
      kind: "semantic-center",
    });
    expect(item.impact.surface.packagePublicContractRelocated).toBe(false);
  });

  it("gives consolidation an exact package delta and an unknown module delta", () => {
    const source = facts(
      {
        edges: [
          { from: B, to: A },
          { from: C, to: A },
        ],
        locality: {
          ...facts().locality,
          sourceModules: 3,
          sourcePackages: 3,
        },
        modules: [
          {
            conversion: 0,
            implementation: 0,
            module: SEED,
            package: A,
            return: 6,
            weak: 0,
          },
          {
            conversion: 0,
            implementation: 0,
            module: B_IMPL,
            package: B,
            return: 3,
            weak: 0,
          },
          {
            conversion: 0,
            implementation: 0,
            module: C_IMPL,
            package: C,
            return: 1,
            weak: 0,
          },
        ],
      },
      {
        behavior: behavior([
          { governing: 6, package: A },
          { governing: 3, package: B },
          { governing: 1, package: C },
        ]),
        finding: finding("boundary-drift", [
          { gravity: 0.6, target: A },
          { gravity: 0.3, target: B },
          { gravity: 0.1, target: C },
        ]),
      }
    );
    const item = simulate(source, "consolidate-behavior");
    expect(item.impact.locality.sourcePackageCount).toEqual({
      certainty: "certain",
      current: 3,
      delta: -2,
      predicted: 1,
    });
    expect(item.impact.locality.sourceModuleCount).toEqual({
      certainty: "unknown",
      current: 3,
      delta: null,
      predicted: null,
    });
    expect(item.impact.locality.behavioralBoundaryEdges.predicted).toBe(0);
    expect(item.uncertainties.map((row) => row.kind)).toContain(
      "target-module-unknown"
    );
    expect(kinds(item)).toContain("behavior-consolidation");
  });

  it("predicts a single-package shape only when the destination already holds enough modules", () => {
    const source = facts({
      modules: [
        {
          conversion: 0,
          implementation: 0,
          module: SEED,
          package: A,
          return: 1,
          weak: 0,
        },
        {
          conversion: 0,
          implementation: 0,
          module: A_IMPL,
          package: A,
          return: 1,
          weak: 0,
        },
        {
          conversion: 0,
          implementation: 0,
          module: "packages/a/src/more.ts",
          package: A,
          return: 0,
          weak: 1,
        },
        {
          conversion: 0,
          implementation: 0,
          module: B_IMPL,
          package: B,
          return: 8,
          weak: 0,
        },
      ],
    });
    const item = simulate(source, "rehome-behavior");
    expect(item.impact.locality.shapeTransition).toEqual({
      certainty: "conditional",
      from: "cross-package-localized",
      to: "single-package-distributed",
    });
    const sparse = simulate(facts(), "rehome-behavior");
    expect(sparse.impact.locality.shapeTransition).toEqual({
      certainty: "unknown",
      from: "cross-package-localized",
    });
  });
});

describe("boundaries", () => {
  it("reduces a shared boundary and keeps the package edge when unrelated modules cross it", () => {
    const source = facts({
      boundaries: [
        boundary({
          conceptImportedModules: [SEED, A_IMPL],
          conceptImportedSitesByModule: [
            { importSites: 8, module: SEED },
            { importSites: 2, module: A_IMPL },
          ],
          conceptImportingModules: [B_IMPL],
          conceptImportSitesByModule: [{ importSites: 10, module: B_IMPL }],
          destinationModules: 4,
          importSites: 25,
          sourceModules: 3,
        }),
      ],
    });
    const item = simulate(source, "rehome-behavior");
    expect(item.impact.boundaries.eliminated).toEqual([]);
    expect(item.impact.boundaries.reduced).toEqual([
      {
        certainty: "conditional",
        conceptImportSitesRemoved: 10,
        conceptInteractionEnds: true,
        edge: "@t/b → @t/a",
        remainingModules: 2,
      },
    ]);
    expect(item.impact.dependency.removed).toEqual([]);
    expect(item.impact.dependency.preserved.map((edge) => edge.from)).toEqual([
      B,
      C,
    ]);
    expect(kinds(item)).toContain("boundary-reduction");
    expect(kinds(item)).not.toContain("dependency-elimination");
  });

  it("eliminates a concept-exclusive boundary and its package edge, conditionally", () => {
    const item = simulate(facts(), "rehome-behavior");
    expect(item.impact.boundaries.eliminated).toEqual(["@t/b → @t/a"]);
    expect(item.impact.dependency.removed.map((edge) => edge.from)).toEqual([
      B,
    ]);
    expect(item.changes).toContainEqual(
      expect.objectContaining({
        certainty: "conditional",
        from: "@t/b → @t/a",
        kind: "dependency-elimination",
      })
    );
    expect(
      item.changes.every(
        (change) =>
          change.certainty !== "certain" ||
          change.kind !== "boundary-elimination"
      )
    ).toBe(true);
  });

  it("never eliminates a boundary that other imported modules still need", () => {
    const source = facts({
      boundaries: [
        boundary({
          conceptImportedSitesByModule: [{ importSites: 6, module: SEED }],
          destinationModules: 2,
        }),
      ],
    });
    const item = simulate(source, "rehome-behavior");
    expect(item.impact.boundaries.eliminated).toEqual([]);
    expect(item.impact.boundaries.reduced[0]).toMatchObject({
      conceptInteractionEnds: true,
      edge: "@t/b → @t/a",
    });
    expect(item.impact.dependency.removed).toEqual([]);
    expect(item.impact.dependency.preserved.map((edge) => edge.from)).toContain(
      B
    );
  });

  it("relaxes elimination to the importing side only when configured", () => {
    const source = facts({
      boundaries: [
        boundary({
          conceptImportedSitesByModule: [{ importSites: 6, module: SEED }],
          destinationModules: 2,
        }),
      ],
    });
    const relaxed: AnalysisConfig = {
      ...ANALYSIS_CONFIG,
      recentering: {
        ...ANALYSIS_CONFIG.recentering,
        impact: {
          ...ANALYSIS_CONFIG.recentering.impact,
          boundary: {
            requireExclusiveConceptContributionForElimination: false,
          },
        },
      },
    };
    const item = simulate(source, "rehome-behavior", relaxed);
    expect(item.impact.dependency.removed.map((edge) => edge.from)).toEqual([
      B,
    ]);
  });

  it("marks a foreign-to-foreign edge with a changed endpoint uncertain and the analysis partial", () => {
    const source = facts(
      {
        boundaries: [
          boundary(),
          boundary({
            conceptImportingModules: [C_IMPL],
            conceptImportSitesByModule: [{ importSites: 10, module: C_IMPL }],
            foreignPackage: C,
            from: C,
          }),
        ],
        edges: [
          { from: B, to: A },
          { from: C, to: A },
          { from: C, to: B },
        ],
        modules: [
          ...facts().modules,
          {
            conversion: 0,
            implementation: 0,
            module: C_IMPL,
            package: C,
            return: 2,
            weak: 0,
          },
        ],
      },
      {
        behavior: behavior([
          { governing: 2, package: A },
          { governing: 8, package: B },
          { governing: 2, package: C },
        ]),
      }
    );
    const item = simulate(source, "rehome-behavior");
    const foreign = item.impact.boundaries.current.find(
      (state) => state.edge === "@t/c → @t/b"
    );
    expect(foreign).toMatchObject({
      certainty: "unknown",
      importSites: null,
      outcome: "uncertain",
    });
    expect(
      item.impact.dependency.uncertain.map(
        (edge) => `${edge.from} → ${edge.to}`
      )
    ).toEqual(["@t/c → @t/b"]);
    expect(item.status).toBe("partially-simulated");
  });
});

describe("consumers and wiring", () => {
  it("keeps the reference halo and weak behavior where they are when behavior relocates", () => {
    const source = facts({
      edges: [
        { from: B, to: A },
        { from: C, to: A },
      ],
      modules: [
        ...facts().modules,
        {
          conversion: 0,
          implementation: 0,
          module: C_IMPL,
          package: C,
          return: 0,
          weak: 4,
        },
      ],
      weakByPackage: [
        { package: B, weak: 3 },
        { package: C, weak: 4 },
      ],
    });
    const item = simulate(source, "rehome-behavior");
    expect(item.impact.behavior.consumerBehaviorUnaffected).toBe(7);
    expect(item.impact.locality.predicted.sourcePackages).toEqual([A, B, C]);
    expect(item.impact.locality.sourcePackageCount.delta).toBe(0);
    expect(item.impact.surface.consumers).toMatchObject({
      impact: "unaffected",
      packages: [B, C],
    });
    expect(item.preserved).toContainEqual(
      expect.objectContaining({ kind: "consumer-boundary" })
    );
    expect(
      item.impact.behavior.predictedByPackage.find((row) => row.package === C)
        ?.weak
    ).toBe(4);
  });

  it("keeps a wiring package's edge when construction stays behind", () => {
    const source = facts(
      {
        boundaries: [
          boundary({
            conceptImportedSitesByModule: [{ importSites: 14, module: SEED }],
            conceptImportingModules: [B_IMPL, B_WIRE],
            conceptImportSitesByModule: [
              { importSites: 10, module: B_IMPL },
              { importSites: 4, module: B_WIRE },
            ],
            importSites: 14,
            sourceModules: 2,
          }),
        ],
        modules: [
          ...facts().modules,
          {
            conversion: 0,
            implementation: 0,
            module: B_WIRE,
            package: B,
            return: 0,
            weak: 2,
          },
        ],
        weakByPackage: [{ package: B, weak: 2 }],
      },
      {
        behavior: behavior([
          { governing: 2, package: A },
          { construction: 2, governing: 8, package: B },
        ]),
      }
    );
    const item = simulate(source, "rehome-behavior");
    expect(item.impact.boundaries.eliminated).toEqual([]);
    expect(item.impact.boundaries.reduced[0]).toMatchObject({
      conceptImportSitesRemoved: 10,
      edge: "@t/b → @t/a",
      remainingModules: 2,
    });
    expect(item.uncertainties).toContainEqual(
      expect.objectContaining({ kind: "composition-root-remains" })
    );
  });
});

describe("representation and implementation", () => {
  const row = {
    file: "packages/b/src/row.ts",
    id: "concept:b:ThingRow",
    inTarget: false,
    kind: "interface" as const,
    name: "ThingRow",
    package: B,
  };

  it("preserves a domain/persistence pair under the baseline and never merges it", () => {
    const source = facts(
      {},
      {
        behavior: behavior([
          { governing: 4, package: A },
          { conversions: 2, governing: 4, package: B },
        ]),
        boundaries: [
          {
            concept: row,
            converterPackages: [B],
            package: B,
            persistenceLike: true,
          },
        ],
        finding: finding("boundary-drift", [
          { gravity: 0.5, target: A },
          { gravity: 0.5, target: B },
        ]),
      }
    );
    const item = simulate(source, "preserve-current");
    expect(item.preserved).toContainEqual({
      detail: `ThingRow in ${B}`,
      kind: "persistence-boundary",
    });
    expect(item.impact.representation).toMatchObject({
      convertersPreserved: [B],
      overlapPairsAffected: [],
      persistenceRepresentationsPreserved: [B],
      representationBoundariesRemoved: [],
    });
    expect(kinds(item)).toContain("representation-boundary-preserved");
  });

  it("makes a formalized boundary explicit without inventing a type or module", () => {
    const source = facts(
      {},
      {
        behavior: behavior([
          { governing: 4, package: A },
          { conversions: 2, governing: 4, package: B },
        ]),
        boundaries: [
          {
            concept: row,
            converterPackages: [B],
            package: B,
            persistenceLike: true,
          },
        ],
        finding: finding("boundary-drift", [
          { gravity: 0.5, target: A },
          { gravity: 0.5, target: B },
        ]),
      }
    );
    const { scenarios } = generateRecenteringScenarios(source.scenario);
    const formalize = scenarios.find(
      (item) => item.kind === "formalize-representation-boundary"
    );
    if (formalize === undefined) {
      // Folded into the baseline: the code already matches the boundary.
      expect(scenarios[0]?.kind).toBe("preserve-current");
      return;
    }
    const item = simulateScenarioImpact(source, formalize);
    expect(item.impact.representation.representationBoundariesAdded).toEqual([
      "ThingRow",
    ]);
    expect(kinds(item)).toContain("representation-boundary-added");
    expect(item.impact.surface.surfaceCautions.join(" ")).toMatch(
      /no new module/
    );
  });

  it("keeps parallel implementations when only semantic responsibility moves", () => {
    const source = facts(
      {
        modules: [
          {
            conversion: 0,
            implementation: 0,
            module: SEED,
            package: A,
            return: 0,
            weak: 0,
          },
          {
            conversion: 0,
            implementation: 1,
            module: A_IMPL,
            package: A,
            return: 0,
            weak: 0,
          },
          {
            conversion: 0,
            implementation: 1,
            module: B_IMPL,
            package: B,
            return: 8,
            weak: 0,
          },
        ],
      },
      {
        behavior: behavior([
          { adapters: 1, governing: 1, package: A },
          { adapters: 1, governing: 9, package: B },
        ]),
        implementationCenters: [A, B],
      }
    );
    const item = simulate(source, "rehome-semantic-center");
    expect(item.impact.implementation).toEqual({
      currentCenters: [A, B],
      parallelImplementationPreserved: true,
      predictedCenters: [A, B],
      preservedImplementations: [A, B],
      relocatedImplementationResponsibility: [],
    });
    expect(item.preserved).toContainEqual({
      detail: `${A}, ${B}`,
      kind: "implementation-split",
    });
    expect(item.impact.behavior.governingBehaviorRelocated).toBe(0);
  });

  it("keeps an adapter-only package in the span and never debits governing for adapters", () => {
    const source = facts(
      {
        modules: [
          {
            conversion: 0,
            implementation: 0,
            module: SEED,
            package: A,
            return: 0,
            weak: 0,
          },
          {
            conversion: 0,
            implementation: 0,
            module: B_IMPL,
            package: B,
            return: 8,
            weak: 0,
          },
          {
            conversion: 0,
            implementation: 1,
            module: C_IMPL,
            package: C,
            return: 0,
            weak: 0,
          },
        ],
      },
      {
        behavior: behavior([
          { governing: 8, package: B },
          { adapters: 1, governing: 0, package: C },
        ]),
        implementationCenters: [C],
      }
    );
    const item = simulate(source, "rehome-behavior");
    expect(item.impact.locality.current.sourcePackages).toEqual([B, C]);
    expect(item.impact.locality.predicted.sourcePackages).toEqual([A, C]);
    const adapter = item.impact.behavior.predictedByPackage.find(
      (row) => row.package === C
    );
    expect(adapter).toMatchObject({ governing: 0, implementation: 1 });
    expect(item.impact.behavior.governingBehaviorRelocated).toBe(8);
    expect(item.impact.behavior.governingBehaviorPreserved).toBe(0);
  });
});

describe("history", () => {
  it("co-locates historically coupled behavior without claiming future coupling disappears", () => {
    const source = facts({
      couplings: [
        {
          coChangeCommits: 13,
          left: SEED,
          leftPackage: A,
          right: B_IMPL,
          rightPackage: B,
        },
      ],
    });
    const item = simulate(source, "rehome-behavior");
    expect(item.impact.evolution).toEqual({
      couplingRelationshipsCoLocated: 1,
      couplingRelationshipsPreserved: 0,
      couplingRelationshipsStillCrossBoundary: 0,
      couplingRelationshipsUnknown: 0,
      historicalEvidenceAlignment: "improves",
      historicallyCoupledFilesAffected: 1,
      hotspotBehaviorRelocated: 0,
    });
    expect(item.uncertainties).toContainEqual(
      expect.objectContaining({ kind: "historical-future-assumption" })
    );
    expect(JSON.stringify(item)).not.toMatch(
      /churn will|coupling will disappear/
    );
  });

  it("records an affected hotspot without claiming complexity improves", () => {
    const item = simulate(
      facts({ hotspotModules: [B_IMPL] }),
      "rehome-behavior"
    );
    expect(item.impact.evolution.hotspotBehaviorRelocated).toBe(1);
    expect(item.summary).toContain(
      "1 hotspot module(s) affected; local complexity unchanged"
    );
  });

  it("reads history as unknown when none is available", () => {
    const item = simulate(
      facts({ historyAvailable: false }),
      "rehome-behavior"
    );
    expect(item.impact.evolution.historicalEvidenceAlignment).toBe("unknown");
  });
});

describe("intent and evidence completeness", () => {
  it("simulates a blocked scenario as a counterfactual and keeps it blocked", () => {
    const source = facts({}, { anchors: [{ package: A, reason: "core" }] });
    const item = simulate(source, "rehome-semantic-center");
    expect(item.status).toBe("blocked");
    expect(item.impact.intent).toMatchObject({
      anchorsViolated: [A],
      compatibility: "incompatible",
    });
    expect(kinds(item)).toContain("semantic-center-change");
    expect(kinds(item)).toContain("anchor-constraint");
    expect(item.constraints[0]?.consequence).toMatch(/counterfactual/);
  });

  it("marks an anchored destination constrained, not incompatible", () => {
    const source = facts({}, { anchors: [{ package: B, reason: "store" }] });
    const item = simulate(source, "rehome-semantic-center");
    expect(item.impact.intent).toMatchObject({
      anchoredResponsibilitiesAdded: [`${B}: semantic-contract`],
      compatibility: "constrained",
    });
    expect(item.status).toBe("simulated");
  });

  it("keeps the analysis partial under unobserved structural conformance", () => {
    const source = facts(
      {},
      {
        finding: finding(
          "external-gravity",
          [
            { gravity: 0.8, target: B },
            { gravity: 0.2, target: A },
          ],
          [{ detail: "", kind: "unobserved-conformance" }]
        ),
        unobservedConformance: true,
      }
    );
    const item = simulate(source, "rehome-behavior");
    expect(item.status).toBe("partially-simulated");
    expect(item.uncertainties).toContainEqual(
      expect.objectContaining({ kind: "structural-conformance-unobserved" })
    );
  });
});

describe("determinism and scope", () => {
  it("returns identical output regardless of evidence order", () => {
    const base = facts({
      couplings: [
        {
          coChangeCommits: 3,
          left: SEED,
          leftPackage: A,
          right: B_IMPL,
          rightPackage: B,
        },
        {
          coChangeCommits: 2,
          left: B_IMPL,
          leftPackage: B,
          right: C_IMPL,
          rightPackage: C,
        },
      ],
      edges: [
        { from: C, to: A },
        { from: B, to: A },
      ],
      modules: [
        ...facts().modules,
        {
          conversion: 0,
          implementation: 0,
          module: C_IMPL,
          package: C,
          return: 0,
          weak: 1,
        },
      ],
      seedImporters: [
        { importSites: 2, package: C },
        { importSites: 10, package: B },
      ],
    });
    const shuffled: ScenarioImpactFacts = {
      ...base,
      couplings: [...base.couplings].reverse(),
      edges: [...base.edges].reverse(),
      modules: [...base.modules].reverse(),
      seedImporters: [...base.seedImporters].reverse(),
    };
    const { scenarios } = generateRecenteringScenarios(base.scenario);
    for (const scenario of scenarios) {
      expect(simulateScenarioImpact(shuffled, scenario)).toEqual(
        simulateScenarioImpact(base, scenario)
      );
    }
  });

  it("names every scenario by its V8.2 id and every dimension for every scenario", () => {
    const source = facts();
    const { scenarios } = generateRecenteringScenarios(source.scenario);
    for (const scenario of scenarios) {
      const item = simulateScenarioImpact(source, scenario);
      expect(item.scenarioId).toBe(scenario.id);
      expect(Object.keys(item.impact).sort()).toEqual([
        "behavior",
        "boundaries",
        "dependency",
        "evolution",
        "implementation",
        "intent",
        "locality",
        "representation",
        "surface",
      ]);
    }
  });

  it("scores, ranks, recommends, and plans nothing", () => {
    const source = facts({ hotspotModules: [B_IMPL] });
    const { scenarios } = generateRecenteringScenarios(source.scenario);
    const text = JSON.stringify(
      scenarios.map((scenario: RecenteringScenario) =>
        simulateScenarioImpact(source, scenario)
      )
    );
    for (const word of [
      "score",
      "rank",
      "preferred",
      "recommend",
      "winner",
      "better",
      "worse",
      "filesToMove",
      "importsToRewrite",
      "operations",
      "steps",
    ]) {
      expect(text).not.toMatch(new RegExp(`"${word}`, "i"));
    }
  });
});
