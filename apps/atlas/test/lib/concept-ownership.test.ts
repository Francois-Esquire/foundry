import { describe, expect, it } from "vitest";
import type { OwnershipFacts } from "../../src/lib/concept-ownership";
import { assessOwnership } from "../../src/lib/concept-ownership";
import type { AnalysisConfig } from "../../src/lib/config";

import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type {
  ChurnFileKind,
  ConceptEvolutionEvidence,
  ConceptPackagePresence,
} from "../../src/lib/types";

function presence(
  pkg: string,
  values: Partial<Omit<ConceptPackagePresence, "package">>
): ConceptPackagePresence {
  return {
    implementations: 0,
    package: pkg,
    references: 0,
    relationshipKinds: [],
    representations: 0,
    seed: pkg === "@t/a",
    ...values,
  };
}

function behaviorRow(
  pkg: string,
  contract: number,
  implementation = 0,
  kind: ChurnFileKind = "source"
) {
  return {
    constructors: 0,
    contract,
    functions: contract,
    implementation,
    kinds: { [kind]: { contract, implementation } },
    methods: implementation,
    package: pkg,
    share: 0,
  };
}

function evolution(
  pkg: string,
  values: Partial<Omit<ConceptEvolutionEvidence, "package" | "support">>
): ConceptEvolutionEvidence {
  const row = {
    changedRepresentationFiles: 0,
    commits: 0,
    couplings: [],
    hotspotRepresentations: 0,
    hotspots: [],
    strongCouplingPairs: 0,
    supportingCouplingPairs: values.strongCouplingPairs ?? 0,
    ...values,
  };
  return {
    package: pkg,
    ...row,
    support:
      row.changedRepresentationFiles +
      row.hotspotRepresentations +
      row.supportingCouplingPairs,
  };
}

function facts(overrides: Partial<OwnershipFacts>): OwnershipFacts {
  const packages = overrides.packages ?? [
    presence("@t/a", { references: 6, representations: 4 }),
  ];
  const behavior = overrides.behavior ?? {
    byPackage: [],
    contractTotal: 0,
    participants: [],
    total: 0,
  };
  return {
    architectureSignals: [],
    concept: {
      file: "packages/a/src/index.ts",
      id: "packages/a/src/index.ts#Thing",
      inTarget: true,
      kind: "interface",
      name: "Thing",
      package: "@t/a",
    },
    contractLike: false,
    conversions: [],
    overlap: [],
    referenceTotal: packages.reduce((sum, row) => sum + row.references, 0),
    representationKinds: packages
      .filter((row) => row.representations > 0)
      .map((row) => ({
        kinds: { source: row.representations },
        package: row.package,
      })),
    representationTotal: packages.reduce(
      (sum, row) => sum + row.representations,
      0
    ),
    ...overrides,
    behavior: {
      byPackage: behavior.byPackage,
      contractTotal: behavior.byPackage.reduce(
        (sum, row) => sum + row.contract,
        0
      ),
      participants: [],
      total: behavior.byPackage.reduce(
        (sum, row) => sum + row.contract + row.implementation,
        0
      ),
    },
    packages,
  };
}

describe("alignment", () => {
  it("returns insufficient evidence below the support gate and infers nothing", () => {
    const result = assessOwnership(
      facts({
        packages: [presence("@t/a", { references: 2, representations: 2 })],
      })
    );
    expect(result.alignment).toBe("insufficient-evidence");
    expect(result.center).toEqual({ implementations: [] });
    expect(result.tensions).toEqual([]);
    expect(result.candidates[0]?.roles).toEqual([]);
  });

  it("aligns when every center is the seed package", () => {
    const result = assessOwnership(
      facts({
        behavior: {
          byPackage: [behaviorRow("@t/a", 4)],
          contractTotal: 0,
          participants: [],
          total: 0,
        },
        packages: [
          presence("@t/a", { references: 8, representations: 5 }),
          presence("@t/b", { references: 1 }),
        ],
      })
    );
    expect(result.alignment).toBe("aligned");
    expect(result.center).toEqual({
      behavior: "@t/a",
      implementations: [],
      representation: "@t/a",
      semantic: "@t/a",
      usage: "@t/a",
    });
    expect(result.candidates.map((item) => item.package)).toEqual([
      "@t/a",
      "@t/b",
    ]);
  });

  it("reads multiple implementation centers as distributed", () => {
    const result = assessOwnership(
      facts({
        packages: [
          presence("@t/a", {
            implementations: 1,
            references: 4,
            representations: 3,
          }),
          presence("@t/b", {
            implementations: 1,
            references: 3,
            representations: 1,
          }),
          presence("@t/c", { references: 2, representations: 1 }),
        ],
      })
    );
    expect(result.alignment).toBe("distributed");
    expect(result.center.implementations).toEqual(["@t/a", "@t/b"]);
    expect(result.center.semantic).toBe("@t/a");
    expect(result.tensions).toEqual([]);
  });

  it("keeps a differing usage center descriptive", () => {
    const result = assessOwnership(
      facts({
        behavior: {
          byPackage: [behaviorRow("@t/a", 3)],
          contractTotal: 0,
          participants: [],
          total: 0,
        },
        packages: [
          presence("@t/a", { references: 3, representations: 4 }),
          presence("@t/b", { references: 9, representations: 1 }),
        ],
      })
    );
    expect(result.center.usage).toBe("@t/b");
    expect(result.tensions).toEqual([
      {
        kind: "usage-vs-semantic-center",
        observedPackage: "@t/b",
        seedPackage: "@t/a",
        value: 0.75,
      },
    ]);
    expect(result.alignment).toBe("distributed");
  });
});

describe("tensions", () => {
  it("flags seed-vs-behavior on contract behavior with enough support", () => {
    const result = assessOwnership(
      facts({
        behavior: {
          byPackage: [behaviorRow("@t/b", 6), behaviorRow("@t/a", 1)],
          contractTotal: 0,
          participants: [],
          total: 0,
        },
        packages: [
          presence("@t/a", { references: 1, representations: 1 }),
          presence("@t/b", { references: 6, representations: 6 }),
        ],
      })
    );
    expect(result.alignment).toBe("divergent");
    expect(result.tensions.map((tension) => tension.kind)).toEqual([
      "seed-vs-representation",
      "seed-vs-behavior",
      "usage-vs-semantic-center",
    ]);
  });

  it("does not let implementation members create seed-vs-behavior", () => {
    const result = assessOwnership(
      facts({
        behavior: {
          byPackage: [behaviorRow("@t/b", 0, 40), behaviorRow("@t/a", 3, 10)],
          contractTotal: 0,
          participants: [],
          total: 0,
        },
        packages: [
          presence("@t/a", {
            implementations: 1,
            references: 5,
            representations: 3,
          }),
          presence("@t/b", {
            implementations: 1,
            references: 4,
            representations: 1,
          }),
        ],
      })
    );
    expect(result.center.behavior).toBe("@t/a");
    expect(result.alignment).toBe("distributed");
  });

  it("ignores a two-function family for seed-vs-behavior", () => {
    const result = assessOwnership(
      facts({
        behavior: {
          byPackage: [behaviorRow("@t/b", 2)],
          contractTotal: 0,
          participants: [],
          total: 0,
        },
        packages: [
          presence("@t/a", { references: 2, representations: 2 }),
          presence("@t/b", { references: 2, representations: 2 }),
        ],
      })
    );
    expect(result.tensions.map((tension) => tension.kind)).not.toContain(
      "seed-vs-behavior"
    );
    expect(result.center.behavior).toBeUndefined();
    expect(result.alignment).not.toBe("divergent");
  });

  it("places the evolution center where history supports it", () => {
    const result = assessOwnership(
      facts({
        evolution: [
          evolution("@t/b", {
            changedRepresentationFiles: 2,
            commits: 30,
            hotspotRepresentations: 1,
            strongCouplingPairs: 2,
          }),
          evolution("@t/a", { commits: 4, strongCouplingPairs: 1 }),
        ],
        packages: [
          presence("@t/a", { references: 3, representations: 2 }),
          presence("@t/b", { references: 3, representations: 3 }),
        ],
      })
    );
    expect(result.center.evolution).toBe("@t/b");
    expect(result.tensions).toContainEqual({
      kind: "seed-vs-evolution",
      observedPackage: "@t/b",
      seedPackage: "@t/a",
      value: 5,
    });
    expect(result.alignment).toBe("divergent");
  });

  it("infers no evolution center from sparse history", () => {
    const result = assessOwnership(
      facts({
        evolution: [evolution("@t/b", { commits: 2, strongCouplingPairs: 1 })],
        packages: [
          presence("@t/a", { references: 3, representations: 2 }),
          presence("@t/b", { references: 3, representations: 3 }),
        ],
      })
    );
    expect(result.center.evolution).toBeUndefined();
    expect(result.tensions.map((tension) => tension.kind)).not.toContain(
      "seed-vs-evolution"
    );
    expect(result.cautions.map((caution) => caution.kind)).toContain(
      "sparse-history"
    );
  });

  it("adds anchor-vs-observed-center only when several dimensions converge elsewhere", () => {
    const anchored = { reason: "intentional boundary" };
    const calm = assessOwnership(
      facts({
        anchor: anchored,
        packages: [
          presence("@t/a", { references: 3, representations: 4 }),
          presence("@t/b", { references: 9 }),
        ],
      })
    );
    expect(calm.tensions.map((tension) => tension.kind)).toEqual([
      "usage-vs-semantic-center",
    ]);
    expect(calm.cautions).toContainEqual({
      detail: "intentional boundary",
      kind: "anchored-seed",
    });
    const oneDimension = assessOwnership(
      facts({
        anchor: anchored,
        packages: [
          presence("@t/a", { references: 1, representations: 1 }),
          presence("@t/b", { references: 9, representations: 9 }),
        ],
      })
    );
    expect(oneDimension.alignment).toBe("divergent");
    expect(oneDimension.tensions.map((tension) => tension.kind)).toEqual([
      "seed-vs-representation",
      "usage-vs-semantic-center",
    ]);
    const converging = assessOwnership(
      facts({
        anchor: anchored,
        behavior: {
          byPackage: [behaviorRow("@t/b", 6), behaviorRow("@t/a", 1)],
          contractTotal: 0,
          participants: [],
          total: 0,
        },
        evolution: [
          evolution("@t/b", { changedRepresentationFiles: 3, commits: 20 }),
          evolution("@t/a", { changedRepresentationFiles: 1, commits: 2 }),
        ],
        packages: [
          presence("@t/a", { references: 1, representations: 1 }),
          presence("@t/b", { references: 9, representations: 9 }),
        ],
      })
    );
    expect(converging.tensions.map((tension) => tension.kind)).toEqual([
      "seed-vs-representation",
      "seed-vs-behavior",
      "seed-vs-evolution",
      "usage-vs-semantic-center",
      "anchor-vs-observed-center",
    ]);
    expect(converging.tensions.at(-1)).toEqual({
      kind: "anchor-vs-observed-center",
      observedPackage: "@t/b",
      seedPackage: "@t/a",
      value: 3,
    });
    expect(converging.candidates[0]?.evidence).toContainEqual({
      dimension: "intent",
      metric: "anchored",
      package: "@t/a",
      value: true,
    });
  });
});

describe("file kinds", () => {
  const kindsBehavior = (sourceB: number, testB: number, sourceA: number) => ({
    byPackage: [
      {
        ...behaviorRow("@t/b", sourceB + testB),
        kinds: {
          source: { contract: sourceB, implementation: 0 },
          test: { contract: testB, implementation: 0 },
        },
      },
      behaviorRow("@t/a", sourceA),
    ],
    contractTotal: 0,
    participants: [],
    total: 0,
  });

  it("centers behavior on source behavior and keeps test behavior visible", () => {
    const result = assessOwnership(
      facts({
        behavior: kindsBehavior(0, 11, 5),
        packages: [
          presence("@t/a", { references: 6, representations: 4 }),
          presence("@t/b", { references: 2 }),
        ],
      })
    );
    expect(result.center.behavior).toBe("@t/a");
    expect(result.tensions).toEqual([]);
    expect(result.alignment).toBe("aligned");
    expect(result.behavior.byPackage[0]).toMatchObject({
      contract: 11,
      kinds: { test: { contract: 11, implementation: 0 } },
      package: "@t/b",
    });
    const b = result.candidates.find((item) => item.package === "@t/b");
    expect(b?.evidence).toContainEqual({
      dimension: "behavior",
      metric: "contract",
      package: "@t/b",
      value: 11,
    });
    expect(b?.evidence.some((item) => item.metric === "sourceContract")).toBe(
      false
    );
  });

  it("lets source behavior elsewhere still diverge", () => {
    const result = assessOwnership(
      facts({
        behavior: kindsBehavior(6, 4, 1),
        packages: [
          presence("@t/a", { references: 6, representations: 4 }),
          presence("@t/b", { references: 2 }),
        ],
      })
    );
    expect(result.center.behavior).toBe("@t/b");
    expect(result.tensions.map((tension) => tension.kind)).toEqual([
      "seed-vs-behavior",
    ]);
    expect(result.tensions[0]?.value).toBeCloseTo(6 / 7);
  });

  it("keeps a test-heavy representation spread visible without moving the center", () => {
    const result = assessOwnership(
      facts({
        packages: [
          presence("@t/a", { references: 6, representations: 4 }),
          presence("@t/b", { references: 2, representations: 6 }),
        ],
        representationKinds: [
          { kinds: { source: 4 }, package: "@t/a" },
          { kinds: { story: 1, test: 5 }, package: "@t/b" },
        ],
      })
    );
    expect(result.center.representation).toBe("@t/a");
    expect(result.alignment).toBe("aligned");
    expect(result.tensions).toEqual([]);
    expect(result.representationKinds).toEqual([
      { kinds: { source: 4 }, package: "@t/a" },
      { kinds: { story: 1, test: 5 }, package: "@t/b" },
    ]);
    const b = result.candidates.find((item) => item.package === "@t/b");
    expect(b?.participation.representations).toBe(6);
    expect(b?.evidence).toContainEqual({
      dimension: "representation",
      metric: "share",
      package: "@t/b",
      value: 0.6,
    });
  });

  it("counts only configured coupling contexts toward evolution support", () => {
    const coupling = (context: "source-source" | "source-test") => ({
      aggregatorMediated: false,
      coChangeCommits: 8,
      conditional: 0.8,
      context,
      file: "packages/b/src/b.ts",
      jaccard: 0.04,
      partnerConditional: 0.04,
      partnerFile: "packages/a/src/index.ts",
      partnerPackage: "@t/a",
      staticPath: "direct" as const,
    });
    const input = (context: "source-source" | "source-test") =>
      facts({
        evolution: [
          evolution("@t/b", {
            changedRepresentationFiles: 2,
            commits: 10,
            couplings: [coupling(context)],
            strongCouplingPairs: 1,
            supportingCouplingPairs: context === "source-source" ? 1 : 0,
          }),
          evolution("@t/a", {
            commits: 200,
            strongCouplingPairs: 1,
            supportingCouplingPairs: 0,
          }),
        ],
        packages: [
          presence("@t/a", { references: 3, representations: 2 }),
          presence("@t/b", { references: 3, representations: 3 }),
        ],
      });
    const viaSource = assessOwnership(input("source-source"));
    expect(viaSource.center.evolution).toBe("@t/b");
    const b = viaSource.candidates.find((item) => item.package === "@t/b");
    expect(b?.evidence).toContainEqual({
      dimension: "evolution",
      metric: "strongestConditional",
      package: "@t/b",
      value: 0.8,
    });
    expect(b?.evidence).toContainEqual({
      dimension: "evolution",
      metric: "strongestContext",
      package: "@t/b",
      value: "source-source",
    });
    const viaTest = assessOwnership(input("source-test"));
    expect(viaTest.center.evolution).toBeUndefined();
    expect(viaTest.evolution?.[0]?.couplings[0]?.context).toBe("source-test");
    expect(viaTest.evolution?.[0]?.strongCouplingPairs).toBe(1);
  });
});

describe("policy and ordering", () => {
  it("honours injected gates deterministically", () => {
    const input = facts({
      packages: [
        presence("@t/a", { references: 4, representations: 2 }),
        presence("@t/b", { references: 3, representations: 4 }),
      ],
    });
    expect(assessOwnership(input).center.representation).toBe("@t/b");
    expect(assessOwnership(input).alignment).toBe("distributed");
    const strict: AnalysisConfig = {
      ...ANALYSIS_CONFIG,
      conceptOwnership: {
        ...ANALYSIS_CONFIG.conceptOwnership,
        tensions: {
          ...ANALYSIS_CONFIG.conceptOwnership.tensions,
          minBehaviors: 5,
          minRepresentations: 5,
          minShare: 0.6,
        },
      },
    };
    expect(assessOwnership(input, strict).alignment).toBe("divergent");
    const loose: AnalysisConfig = {
      ...ANALYSIS_CONFIG,
      conceptOwnership: {
        ...ANALYSIS_CONFIG.conceptOwnership,
        representationCenter: {
          ...ANALYSIS_CONFIG.conceptOwnership.representationCenter,
          minShare: 0.9,
        },
      },
    };
    expect(assessOwnership(input, loose).center.representation).toBeUndefined();
  });

  it("drops incidental packages and sorts candidates without a hidden score", () => {
    const result = assessOwnership(
      facts({
        packages: [
          presence("@t/a", { references: 10, representations: 3 }),
          presence("@t/c", { references: 4, representations: 1 }),
          presence("@t/b", { references: 4, representations: 1 }),
          presence("@t/z", { references: 1 }),
        ],
      })
    );
    expect(result.candidates.map((item) => item.package)).toEqual([
      "@t/a",
      "@t/b",
      "@t/c",
    ]);
    expect(result.candidates[0]?.dimensions).toEqual([
      "declaration",
      "representation",
      "reference",
    ]);
    expect(JSON.stringify(result)).not.toContain("score");
  });
});
