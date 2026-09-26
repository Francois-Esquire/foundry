import { describe, expect, it } from "vitest";
import type { RecenteringFacts } from "../../src/lib/concept-recentering";
import type {
  ScenarioBehaviorPackage,
  ScenarioFacts,
} from "../../src/lib/concept-scenarios";
import {
  deriveScenarioFacts,
  generateRecenteringScenarios,
} from "../../src/lib/concept-scenarios";
import type { AnalysisConfig } from "../../src/lib/config";

import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type {
  MiscenteredConceptFinding,
  MiscenteringSignal,
  RecenteringScenario,
} from "../../src/lib/types";

const A = "@t/a";
const B = "@t/b";
const C = "@t/c";

function finding(
  signal: MiscenteringSignal,
  centers: { target: string; gravity: number }[],
  cautions: MiscenteredConceptFinding["cautions"] = []
): MiscenteredConceptFinding {
  return {
    anchored: false,
    cautions,
    concept: {
      file: "packages/a/src/thing.ts",
      id: "concept:a:Thing",
      inTarget: true,
      kind: "interface",
      name: "Thing",
      package: A,
    },
    declaredHome: {
      anchored: false,
      module: "packages/a/src/thing.ts",
      package: A,
    },
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

function facts(overrides: Partial<ScenarioFacts> = {}): ScenarioFacts {
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
    publicContract: false,
    referenceShares: shares({ [A]: 1, [B]: 1 }),
    representationShares: shares({ [A]: 3, [B]: 7 }),
    supportingFamilies: [],
    unobservedConformance: false,
    ...overrides,
  };
}

function kinds(scenarios: RecenteringScenario[]): string[] {
  return scenarios.map((item) => item.kind);
}

function packagesOf(
  item: RecenteringScenario | undefined,
  responsibility: string
) {
  return item?.proposed.responsibilities.find(
    (row) => row.responsibility === responsibility
  )?.packages;
}

describe("external findings", () => {
  it("generates the baseline and both readings", () => {
    const { scenarios, candidateCenters } = generateRecenteringScenarios(
      facts()
    );
    expect(kinds(scenarios)).toEqual([
      "preserve-current",
      "rehome-semantic-center",
      "rehome-behavior",
    ]);
    expect(candidateCenters.map((center) => center.package)).toEqual([A, B]);
    const [baseline, semantic, behaviorHome] = scenarios;
    expect(baseline?.proposed).toEqual(baseline?.current);
    expect(baseline?.affectedResponsibilities).toEqual([]);
    expect(semantic?.proposed.semanticCenter).toBe(B);
    expect(semantic?.affectedResponsibilities).toEqual(["semantic-contract"]);
    expect(packagesOf(semantic, "domain-behavior")).toEqual([A, B]);
    expect(behaviorHome?.proposed.semanticCenter).toBe(A);
    expect(packagesOf(behaviorHome, "domain-behavior")).toEqual([A]);
    expect(scenarios.every((item) => item.status === "plausible")).toBe(true);
  });

  it("never turns a reference-only center into a destination", () => {
    const result = generateRecenteringScenarios(
      facts({ referenceShares: shares({ [A]: 1, [B]: 1, [C]: 20 }) })
    );
    expect(result.candidateCenters.map((center) => center.package)).toEqual([
      A,
      B,
    ]);
    for (const item of result.scenarios) {
      expect(item.proposed.semanticCenter).not.toBe(C);
      expect(packagesOf(item, "domain-behavior")).not.toContain(C);
      expect(packagesOf(item, "consumption")).toContain(C);
    }
  });

  it("keeps a package without concept evidence out of every placement", () => {
    const json = JSON.stringify(generateRecenteringScenarios(facts()));
    expect(json).not.toContain(C);
  });

  it("marks a semantic rehome constrained by a public contract", () => {
    const { scenarios } = generateRecenteringScenarios(
      facts({ publicContract: true })
    );
    const semantic = scenarios[1];
    expect(semantic?.status).toBe("constrained");
    expect(semantic?.constraints).toEqual([
      { kind: "public-contract", package: A },
    ]);
    expect(scenarios[2]?.status).toBe("plausible");
    expect(
      scenarios[2]?.rationale.some((item) => item.kind === "public-contract")
    ).toBe(true);
  });
});

describe("anchors", () => {
  it("blocks a semantic rehome out of an anchored home and keeps the evidence", () => {
    const { scenarios, diagnostics } = generateRecenteringScenarios(
      facts({ anchors: [{ package: A, reason: "core is fixed" }] })
    );
    const semantic = scenarios[1];
    expect(semantic?.kind).toBe("rehome-semantic-center");
    expect(semantic?.status).toBe("blocked");
    expect(semantic?.constraints).toEqual([
      { kind: "anchor", package: A, reason: "core is fixed" },
    ]);
    expect(semantic?.rationale.length).toBeGreaterThan(0);
    expect(semantic?.anchorContext).toEqual({
      anchoredCenters: [A],
      homeAnchored: true,
    });
    expect(diagnostics.blocked).toBe(1);
    const behaviorHome = scenarios[2];
    expect(behaviorHome?.kind).toBe("rehome-behavior");
    expect(behaviorHome?.status).toBe("plausible");
    expect(behaviorHome?.rationale.some((item) => item.kind === "anchor")).toBe(
      true
    );
  });

  it("constrains movement into and out of an anchored observed center", () => {
    const { scenarios } = generateRecenteringScenarios(
      facts({ anchors: [{ package: B }] })
    );
    expect(scenarios[1]?.status).toBe("constrained");
    expect(scenarios[1]?.constraints).toEqual([
      { kind: "anchor", package: B, reason: "anchored package" },
    ]);
    expect(scenarios[1]?.cautions.map((item) => item.kind)).toContain(
      "observed-center-anchored"
    );
    expect(scenarios[2]?.status).toBe("constrained");
  });
});

describe("drift and split findings", () => {
  it("keeps drift conservative: baseline plus consolidation toward the home", () => {
    const { scenarios } = generateRecenteringScenarios(
      facts({
        behavior: behavior([
          { governing: 7, package: A },
          { governing: 3, package: B },
        ]),
        finding: finding("boundary-drift", [
          { gravity: 0.6, target: A },
          { gravity: 0.4, target: B },
        ]),
        representationShares: shares({ [A]: 8, [B]: 2 }),
      })
    );
    expect(kinds(scenarios)).toEqual([
      "preserve-current",
      "consolidate-behavior",
    ]);
    expect(packagesOf(scenarios[1], "domain-behavior")).toEqual([A]);
  });

  it("generates a semantic rehome for drift only when weak rehomes are allowed", () => {
    const config: AnalysisConfig = {
      ...ANALYSIS_CONFIG,
      recentering: {
        ...ANALYSIS_CONFIG.recentering,
        scenarios: {
          ...ANALYSIS_CONFIG.recentering.scenarios,
          allowWeakRehome: true,
        },
      },
    };
    const drift = facts({
      behavior: behavior([
        { governing: 3, package: A },
        { governing: 7, package: B },
      ]),
      finding: finding("boundary-drift", [
        { gravity: 0.55, target: B },
        { gravity: 0.45, target: A },
      ]),
      representationShares: shares({ [A]: 8, [B]: 2 }),
    });
    expect(kinds(generateRecenteringScenarios(drift).scenarios)).not.toContain(
      "rehome-semantic-center"
    );
    expect(
      kinds(generateRecenteringScenarios(drift, config).scenarios)
    ).toContain("rehome-semantic-center");
  });

  it("offers a split the baseline plus consolidation toward each supported center", () => {
    const { scenarios } = generateRecenteringScenarios(
      facts({
        behavior: behavior([
          { governing: 11, package: A },
          { governing: 9, package: B },
        ]),
        finding: finding("split-gravity", [
          { gravity: 0.55, target: A },
          { gravity: 0.45, target: B },
        ]),
        representationShares: shares({ [A]: 1, [B]: 1 }),
      })
    );
    expect(kinds(scenarios)).toEqual([
      "preserve-current",
      "consolidate-behavior",
      "consolidate-behavior",
    ]);
    expect(
      scenarios.slice(1).map((item) => packagesOf(item, "domain-behavior"))
    ).toEqual([[A], [B]]);
    expect(
      scenarios[0]?.rationale.some(
        (item) => item.kind === "localized-current-split"
      )
    ).toBe(true);
  });

  it("reads parallel implementations as baseline evidence and never forces consolidation first", () => {
    const { scenarios } = generateRecenteringScenarios(
      facts({
        behavior: behavior([
          { adapters: 1, governing: 5, package: A },
          { adapters: 1, governing: 5, package: B },
        ]),
        finding: finding("split-gravity", [
          { gravity: 0.5, target: A },
          { gravity: 0.5, target: B },
        ]),
        implementationCenters: [A, B],
        representationShares: shares({ [A]: 1, [B]: 1 }),
      })
    );
    expect(scenarios[0]?.kind).toBe("preserve-current");
    expect(scenarios[0]?.status).toBe("plausible");
    expect(
      scenarios[0]?.rationale.find(
        (item) => item.kind === "implementation-center"
      )?.detail
    ).toBe("2 parallel implementation centers");
  });
});

describe("representation boundaries and responsibility splits", () => {
  const stored = facts({
    behavior: behavior([
      { governing: 6, package: A },
      { conversions: 4, governing: 4, package: B },
    ]),
    boundaries: [
      {
        concept: {
          file: "packages/b/src/row.ts",
          id: "concept:b:ThingRow",
          inTarget: false,
          kind: "interface",
          name: "ThingRow",
          package: B,
        },
        converterPackages: [B],
        package: B,
        persistenceLike: true,
      },
    ],
    finding: finding("boundary-drift", [
      { gravity: 0.6, target: A },
      { gravity: 0.4, target: B },
    ]),
    representationShares: shares({ [A]: 7, [B]: 3 }),
  });

  it("describes a domain/persistence pair as a boundary, never a merge", () => {
    const { scenarios, diagnostics } = generateRecenteringScenarios(stored);
    expect(kinds(scenarios)).toEqual([
      "preserve-current",
      "consolidate-behavior",
    ]);
    const current = scenarios[0]?.current;
    expect(
      current?.responsibilities.find(
        (row) => row.responsibility === "persistence"
      )?.packages
    ).toEqual([B]);
    expect(
      current?.responsibilities.find(
        (row) => row.responsibility === "conversion"
      )?.packages
    ).toEqual([B]);
    expect(
      scenarios[0]?.rationale.some(
        (item) => item.kind === "conversion-boundary"
      )
    ).toBe(true);
    // The boundary and split kinds reach the same placement as consolidation
    // (B's behavior is entirely converters), so they fold into it.
    expect(diagnostics.deduplicated).toBe(2);
    const consolidate = scenarios[1];
    expect(packagesOf(consolidate, "domain-behavior")).toEqual([A]);
    expect(packagesOf(consolidate, "persistence")).toEqual([B]);
    expect(packagesOf(consolidate, "conversion")).toEqual([B]);
    expect(
      consolidate?.rationale.some(
        (item) =>
          item.kind === "conversion-boundary" && item.supports === "split"
      )
    ).toBe(true);
  });

  it("merges rules that reach the same placement and keeps one scenario", () => {
    const { scenarios, diagnostics } = generateRecenteringScenarios(
      facts({
        behavior: behavior([
          { governing: 2, package: A },
          { conversions: 8, governing: 8, package: B },
        ]),
      })
    );
    expect(diagnostics.deduplicated).toBe(1);
    expect(kinds(scenarios)).toEqual([
      "preserve-current",
      "rehome-semantic-center",
      "rehome-behavior",
    ]);
    const merged = scenarios[2];
    expect(
      merged?.rationale.some(
        (item) =>
          item.kind === "conversion-boundary" && item.supports === "split"
      )
    ).toBe(true);
    expect(new Set(scenarios.map((item) => item.id)).size).toBe(
      scenarios.length
    );
  });
});

describe("evidence quality", () => {
  it("keeps a semantic rehome weak and constrained under unobserved conformance", () => {
    const { scenarios } = generateRecenteringScenarios(
      facts({
        finding: finding(
          "external-gravity",
          [
            { gravity: 0.8, target: B },
            { gravity: 0.2, target: A },
          ],
          [{ detail: "", kind: "unobserved-conformance" }]
        ),
        supportingFamilies: [{ families: ["X", "Y", "Z"], package: B }],
        unobservedConformance: true,
      })
    );
    const semantic = scenarios[1];
    expect(semantic?.status).toBe("constrained");
    expect(semantic?.confidence).toBe("weak");
    expect(semantic?.constraints).toContainEqual({
      concept: "Thing",
      kind: "structural-conformance-unknown",
    });
    expect(semantic?.cautions.map((item) => item.kind)).toContain(
      "unobserved-conformance"
    );
  });

  it("flags a wiring-dominated destination and never rates it strong", () => {
    const { scenarios } = generateRecenteringScenarios(
      facts({
        behavior: behavior([
          { governing: 1, package: A },
          { construction: 6, governing: 1, package: B },
        ]),
        representationShares: shares({ [A]: 9, [B]: 1 }),
      })
    );
    const semantic = scenarios.find(
      (item) => item.kind === "rehome-semantic-center"
    );
    expect(semantic?.cautions.map((item) => item.kind)).toContain(
      "integration-center"
    );
    expect(semantic?.confidence).not.toBe("strong");
  });

  it("counts distinct rationale kinds: three strong, two moderate, fewer weak", () => {
    const strong = generateRecenteringScenarios(
      facts({
        implementationCenters: [B],
        supportingFamilies: [{ families: ["X", "Y"], package: B }],
      })
    ).scenarios[1];
    expect(strong?.confidence).toBe("strong");
    const moderate = generateRecenteringScenarios(facts()).scenarios[1];
    expect(moderate?.confidence).toBe("moderate");
    const weak = generateRecenteringScenarios(
      facts({ representationShares: shares({ [A]: 9, [B]: 1 }) })
    ).scenarios[1];
    expect(weak?.confidence).toBe("weak");
  });

  it("qualifies a center on strongly related families and ignores name-only overlap", () => {
    const base = facts({
      supportingFamilies: [
        { families: ["ThingRow", "ThingStore"], package: B },
        { families: ["Thingamajig"], package: C },
      ],
    });
    const { candidateCenters } = generateRecenteringScenarios(base);
    expect(
      candidateCenters.find((center) => center.package === B)?.reasons
        .supportingFamilies
    ).toBe(2);
    expect(candidateCenters.some((center) => center.package === C)).toBe(false);
  });
});

describe("determinism and scope", () => {
  it("assigns identical ids regardless of evidence order", () => {
    const base = facts({
      behavior: behavior([
        { governing: 2, package: A },
        { governing: 8, package: B },
        { governing: 3, package: C },
      ]),
      representationShares: shares({ [A]: 3, [B]: 7, [C]: 2 }),
      supportingFamilies: [
        { families: ["Y", "X"], package: B },
        { families: ["Q", "P"], package: C },
      ],
    });
    const reversed: ScenarioFacts = {
      ...base,
      behavior: [...base.behavior].reverse(),
      representationShares: [...base.representationShares].reverse(),
      supportingFamilies: [...base.supportingFamilies].reverse(),
    };
    const first = generateRecenteringScenarios(base);
    const second = generateRecenteringScenarios(reversed);
    expect(second.scenarios.map((item) => item.id)).toEqual(
      first.scenarios.map((item) => item.id)
    );
    expect(second.scenarios.map((item) => item.proposed)).toEqual(
      first.scenarios.map((item) => item.proposed)
    );
    for (const item of first.scenarios) {
      expect(item.id).toBe(
        `${item.findingId}::${item.kind}::semantic=${item.proposed.semanticCenter};${item.proposed.responsibilities
          .map((row) => `${row.responsibility}=${row.packages.join(",")}`)
          .join(";")}`
      );
    }
  });

  it("truncates by kind precedence, never by confidence", () => {
    const config: AnalysisConfig = {
      ...ANALYSIS_CONFIG,
      recentering: {
        ...ANALYSIS_CONFIG.recentering,
        scenarios: {
          ...ANALYSIS_CONFIG.recentering.scenarios,
          maxScenariosPerFinding: 2,
        },
      },
    };
    const { scenarios, diagnostics } = generateRecenteringScenarios(
      facts(),
      config
    );
    expect(kinds(scenarios)).toEqual([
      "preserve-current",
      "rehome-semantic-center",
    ]);
    expect(diagnostics.truncated).toBe(1);
  });

  it("explains a baseline-only finding", () => {
    const { scenarios, diagnostics } = generateRecenteringScenarios(
      facts({
        behavior: behavior([{ governing: 5, package: A }]),
        finding: finding("boundary-drift", [{ gravity: 1, target: A }]),
        representationShares: shares({ [A]: 1 }),
      })
    );
    expect(kinds(scenarios)).toEqual(["preserve-current"]);
    expect(diagnostics.noAlternativeReason).toBe(
      "every alternative collapsed into the current arrangement"
    );
  });

  it("predicts no delta and prefers nothing", () => {
    const json = JSON.stringify(generateRecenteringScenarios(facts()));
    for (const word of [
      "predictedDelta",
      "importChanges",
      "dependencyChanges",
      "filesMoved",
      "recommended",
      "preferred",
      "winner",
      "rank",
      "score",
    ]) {
      expect(json).not.toContain(word);
    }
  });
});

describe("deriveScenarioFacts", () => {
  function recenteringFacts(
    overrides: Partial<RecenteringFacts> = {}
  ): RecenteringFacts {
    const empty = {
      construction: 0,
      conversion: 0,
      implementation: 0,
      "parameter-consumer": 0,
      return: 0,
    };
    return {
      alignment: "divergent",
      behavior: {
        byKind: { ...empty, construction: 1, return: 4 },
        byPackage: [
          {
            byKind: { ...empty, return: 3 },
            package: B,
            strong: 3,
            weak: 0,
          },
          {
            byKind: { ...empty, return: 1 },
            package: A,
            strong: 1,
            weak: 0,
          },
          {
            byKind: { ...empty, construction: 1 },
            package: C,
            strong: 0,
            weak: 1,
          },
        ],
        primaryStrongPackage: B,
        primaryStrongShare: 0.75,
        source: 5,
        strong: 4,
        strongModules: 2,
        topTwoStrongModuleShare: 1,
        weak: 1,
      },
      behaviorEdges: [],
      behaviorModules: [],
      boundaries: [],
      concept: finding("external-gravity", []).concept,
      consumerBoundaries: [],
      contractWithoutImplementations: true,
      disconnectedPairs: [],
      distribution: {
        representation: { package: B, share: 0.7 },
        usage: { package: B, share: 0.67 },
      },
      distributionShapes: ["cross-package"],
      halo: { modules: 3, packages: 3, references: 6 },
      hotspotModules: [],
      intent: {
        anchoredObservedPackages: [],
        representationBoundaries: [],
        seedAnchored: false,
      },
      locality: {
        disconnectedModules: 0,
        disconnectedPackagePairs: 0,
        maxModuleDistance: 1,
        modifiers: [],
        primaryPackageShare: 0.6,
        shape: "cross-package-localized",
        sourceBehaviors: 5,
        sourceModules: 3,
        sourcePackages: 3,
        topTwoModuleShare: 1,
      },
      localityCautions: [],
      ownershipTensions: [],
      placement: {
        behaviorPackages: [A, B],
        implementationCenters: [],
        seedPackage: A,
      },
      referenceShares: shares({ [A]: 1, [B]: 2 }),
      relatedFamilies: [
        {
          bidirectional: true,
          concept: {
            file: "packages/b/src/row.ts",
            id: "concept:b:ThingRow",
            inTarget: false,
            kind: "interface",
            name: "ThingRow",
            package: B,
          },
          converterPackages: [B],
          relation: "conversion",
        },
        {
          bidirectional: false,
          concept: {
            file: "packages/b/src/store.ts",
            id: "concept:b:ThingStore",
            inTarget: false,
            kind: "interface",
            name: "ThingStore",
            package: B,
          },
          converterPackages: [],
          relation: "projection",
        },
        {
          bidirectional: false,
          concept: {
            file: "packages/c/src/x.ts",
            id: "concept:c:Thingamajig",
            inTarget: false,
            kind: "type",
            name: "Thingamajig",
            package: C,
          },
          converterPackages: [],
          relation: "name",
        },
      ],
      representationShares: shares({ [A]: 3, [B]: 7 }),
      seed: {
        externallyUsed: true,
        kind: "interface",
        module: "packages/a/src/thing.ts",
        packagePublic: true,
      },
      seedImportSites: [],
      sourceCouplings: [],
      ...overrides,
    };
  }

  it("reads behavior, supporting families, wiring, and the public contract from V8.0 facts", () => {
    const derived = deriveScenarioFacts(
      finding("external-gravity", [
        { gravity: 0.8, target: B },
        { gravity: 0.2, target: A },
      ]),
      recenteringFacts()
    );
    expect(derived.behavior).toEqual([
      {
        adapters: 0,
        construction: 0,
        conversions: 0,
        governing: 1,
        governingShare: 0.25,
        package: A,
      },
      {
        adapters: 0,
        construction: 0,
        conversions: 0,
        governing: 3,
        governingShare: 0.75,
        package: B,
      },
      {
        adapters: 0,
        construction: 1,
        conversions: 0,
        governing: 0,
        governingShare: 0,
        package: C,
      },
    ]);
    expect(derived.supportingFamilies).toEqual([
      { families: ["ThingRow", "ThingStore"], package: B },
    ]);
    expect(derived.publicContract).toBe(true);
    const { scenarios, candidateCenters } =
      generateRecenteringScenarios(derived);
    expect(candidateCenters.map((center) => center.package)).toEqual([A, B]);
    expect(packagesOf(scenarios[0], "integration")).toEqual([C]);
  });
});
