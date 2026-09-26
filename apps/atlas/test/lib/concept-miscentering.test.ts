import { describe, expect, it } from "vitest";
import {
  assessMiscentering,
  findMiscenteredConcepts,
} from "../../src/lib/concept-miscentering";
import type {
  RecenteringBoundaryUse,
  RecenteringFacts,
} from "../../src/lib/concept-recentering";
import type { AnalysisConfig } from "../../src/lib/config";

import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type {
  RecenteringBehaviorEvidenceKind,
  RecenteringBehaviorProfile,
} from "../../src/lib/types";

const A = "@t/a";
const B = "@t/b";
const C = "@t/c";
const SEED = "packages/a/src/thing.ts";

type Kinds = Partial<Record<RecenteringBehaviorEvidenceKind, number>>;

const STRONG: RecenteringBehaviorEvidenceKind[] = [
  "implementation",
  "conversion",
  "return",
];

function profile(
  rows: { package: string; kinds: Kinds }[]
): RecenteringBehaviorProfile {
  const empty = (): Record<RecenteringBehaviorEvidenceKind, number> => ({
    construction: 0,
    conversion: 0,
    implementation: 0,
    "parameter-consumer": 0,
    return: 0,
  });
  const byKind = empty();
  const byPackage = rows.map((row) => {
    const kinds = empty();
    let strong = 0;
    let weak = 0;
    for (const [kind, count] of Object.entries(row.kinds) as [
      RecenteringBehaviorEvidenceKind,
      number,
    ][]) {
      kinds[kind] = count;
      byKind[kind] += count;
      if (STRONG.includes(kind)) {
        strong += count;
      } else {
        weak += count;
      }
    }
    return { byKind: kinds, package: row.package, strong, weak };
  });
  byPackage.sort((x, y) => y.strong - x.strong);
  const strong = byPackage.reduce((sum, row) => sum + row.strong, 0);
  const weak = byPackage.reduce((sum, row) => sum + row.weak, 0);
  const top = byPackage[0];
  return {
    byKind,
    byPackage,
    source: strong + weak,
    strong,
    strongModules: byPackage.length,
    topTwoStrongModuleShare: strong === 0 ? null : 1,
    weak,
    ...(top !== undefined &&
      top.strong > 0 && { primaryStrongPackage: top.package }),
    primaryStrongShare:
      top === undefined || strong === 0 ? null : top.strong / strong,
  };
}

function shares(
  rows: Record<string, number>
): { package: string; share: number }[] {
  const total = Object.values(rows).reduce((sum, value) => sum + value, 0);
  return Object.entries(rows).map(([pkg, value]) => ({
    package: pkg,
    share: value / total,
  }));
}

function boundary(foreign: string): RecenteringBoundaryUse {
  return {
    conceptImportedModules: [SEED],
    conceptImportedSitesByModule: [{ importSites: 4, module: SEED }],
    conceptImportingModules: [`packages/${foreign.slice(3)}/src/use.ts`],
    conceptImportSitesByModule: [
      { importSites: 4, module: `packages/${foreign.slice(3)}/src/use.ts` },
    ],
    destinationModules: 1,
    foreignPackage: foreign,
    from: foreign,
    importSites: 4,
    sourceModules: 2,
    to: A,
  };
}

function facts(overrides: Partial<RecenteringFacts> = {}): RecenteringFacts {
  const behavior =
    overrides.behavior ?? profile([{ kinds: { return: 3 }, package: A }]);
  const packages = [
    ...new Set([A, ...behavior.byPackage.map((row) => row.package)]),
  ];
  return {
    alignment: "aligned",
    behavior,
    behaviorEdges: [],
    behaviorModules: [],
    boundaries: [],
    concept: {
      file: SEED,
      id: `${SEED}#Thing`,
      inTarget: true,
      kind: "interface",
      name: "Thing",
      package: A,
    },
    consumerBoundaries: [],
    contractWithoutImplementations: false,
    disconnectedPairs: [],
    distribution: {
      representation: { package: A, share: 1 },
      usage: { package: A, share: 1 },
    },
    distributionShapes: ["local"],
    halo: { modules: 2, packages: 1, references: 4 },
    hotspotModules: [],
    intent: {
      anchoredObservedPackages: [],
      representationBoundaries: [],
      seedAnchored: false,
    },
    locality: {
      disconnectedModules: 0,
      disconnectedPackagePairs: 0,
      maxModuleDistance: packages.length > 1 ? 2 : null,
      modifiers: [],
      primaryPackageShare: behavior.primaryStrongShare,
      shape: packages.length > 1 ? "cross-package-localized" : "local",
      sourceBehaviors: behavior.source,
      sourceModules: behavior.strongModules,
      sourcePackages: packages.length,
      topTwoModuleShare: behavior.topTwoStrongModuleShare,
    },
    localityCautions: [],
    ownershipTensions: [],
    placement: {
      behaviorPackages: packages,
      implementationCenters: [],
      seedPackage: A,
      semanticCenter: A,
    },
    referenceShares: shares({ [A]: 1 }),
    relatedFamilies: [],
    representationShares: shares({ [A]: 1 }),
    seed: {
      externallyUsed: true,
      kind: "interface",
      module: SEED,
      packagePublic: true,
    },
    seedImportSites: [],
    sourceCouplings: [],
    ...overrides,
  };
}

/** Declared in A; behavior, symbols, and references all sit in B. */
function external(): RecenteringFacts {
  return facts({
    behavior: profile([
      { kinds: { return: 5 }, package: B },
      { kinds: { "parameter-consumer": 1 }, package: A },
    ]),
    distributionShapes: ["cross-package"],
    referenceShares: shares({ [A]: 2, [B]: 8 }),
    representationShares: shares({ [A]: 1, [B]: 4 }),
    seedImportSites: [{ importSites: 9, package: B }],
  });
}

describe("external gravity", () => {
  it("emits when another package leads on behavior and a second family", () => {
    const { outcome, finding } = assessMiscentering(external());
    expect(outcome).toBe("finding");
    expect(finding?.signal).toBe("external-gravity");
    expect(finding?.declaredHome).toEqual({
      anchored: false,
      module: SEED,
      package: A,
    });
    expect(finding?.observedCenters[0]?.target).toBe(B);
    expect(finding?.observedCenters[0]?.gravity).toBeGreaterThan(0.8);
    expect(finding?.supportingFamilies).toEqual([
      "behavioral-locality",
      "symbol-distribution",
      "consumer-gravity",
      "dependency-gravity",
    ]);
    expect(finding?.mismatch).toBeGreaterThan(0.5);
    expect(finding?.evidenceConfidence).toBeGreaterThan(0.5);
    expect(finding?.evidenceConfidence).toBeLessThanOrEqual(1);
    expect(finding?.summary).toContain("gravity points to @t/b");
    expect(finding?.summary).not.toMatch(/move|relocat|should/);
  });

  it("never emits on consumption alone: behavior stays home, outcome usage-only", () => {
    const { outcome, finding } = assessMiscentering(
      facts({
        behavior: profile([
          { kinds: { return: 3 }, package: A },
          { kinds: { "parameter-consumer": 12 }, package: B },
        ]),
        referenceShares: shares({ [A]: 1, [B]: 9 }),
        representationShares: shares({ [A]: 1, [B]: 9 }),
        seedImportSites: [{ importSites: 30, package: B }],
      })
    );
    expect(finding).toBeUndefined();
    expect(outcome).toBe("usage-only");
  });

  it("needs a second family beside behavior", () => {
    const { outcome } = assessMiscentering(
      facts({
        behavior: profile([{ kinds: { return: 5 }, package: B }]),
        referenceShares: shares({ [A]: 3, [B]: 1 }),
        representationShares: shares({ [A]: 3, [B]: 1 }),
      })
    );
    expect(outcome).toBe("unclear");
  });

  it("never reads a shared type with few producers as mis-centered", () => {
    const { outcome } = assessMiscentering(
      facts({
        behavior: profile([
          { kinds: { return: 1 }, package: A },
          { kinds: { "parameter-consumer": 20 }, package: B },
          { kinds: { "parameter-consumer": 15 }, package: C },
        ]),
        referenceShares: shares({ [A]: 1, [B]: 20, [C]: 15 }),
        seed: {
          externallyUsed: true,
          kind: "type",
          module: SEED,
          packagePublic: true,
        },
      })
    );
    expect(outcome).toBe("behavior-light");
  });
});

describe("adapters", () => {
  it("does not count implementations of an interface outside its home as governing behavior", () => {
    const { outcome, finding } = assessMiscentering(
      facts({
        behavior: profile([
          { kinds: { implementation: 6 }, package: B },
          { kinds: { implementation: 4 }, package: C },
          { kinds: { return: 1 }, package: A },
        ]),
        placement: {
          behaviorPackages: [A, B, C],
          implementationCenters: [B, C],
          seedPackage: A,
          semanticCenter: A,
        },
        referenceShares: shares({ [A]: 2, [B]: 4, [C]: 3 }),
        representationShares: shares({ [A]: 1, [B]: 1, [C]: 1 }),
      })
    );
    expect(finding).toBeUndefined();
    expect(outcome).toBe("behavior-light");
  });

  it("counts implementations when the seed is a class", () => {
    const { finding } = assessMiscentering(
      facts({
        behavior: profile([
          { kinds: { implementation: 6 }, package: B },
          { kinds: { return: 1 }, package: A },
        ]),
        referenceShares: shares({ [A]: 2, [B]: 8 }),
        representationShares: shares({ [A]: 1, [B]: 4 }),
        seed: {
          externallyUsed: true,
          kind: "class",
          module: SEED,
          packagePublic: true,
        },
      })
    );
    expect(finding?.signal).toBe("external-gravity");
  });

  it("warns when an interface has no implements clause but foreign factories return it", () => {
    const { finding } = assessMiscentering(
      facts({ ...external(), contractWithoutImplementations: true })
    );
    expect(finding?.cautions.map((item) => item.kind)).toContain(
      "unobserved-conformance"
    );
  });
});

describe("split gravity", () => {
  function split(): RecenteringFacts {
    return facts({
      behavior: profile([
        { kinds: { return: 2 }, package: A },
        { kinds: { return: 2 }, package: B },
        { kinds: { return: 2 }, package: C },
      ]),
      distributionShapes: ["cross-package", "reference-distributed"],
      referenceShares: shares({ [A]: 3, [B]: 3, [C]: 3 }),
      representationShares: shares({ [A]: 2, [B]: 2, [C]: 2 }),
    });
  }

  it("emits when no package dominates behavior and a second family divides too", () => {
    const { finding } = assessMiscentering(split());
    expect(finding?.signal).toBe("split-gravity");
    expect(finding?.supportingFamilies).toEqual([
      "behavioral-locality",
      "symbol-distribution",
      "consumer-gravity",
      "concept-distribution",
    ]);
    expect(finding?.observedCenters.map((center) => center.target)).toEqual([
      A,
      B,
      C,
    ]);
    expect(finding?.summary).toContain("no dominant observed center");
  });

  it("reads an ambiguous 36/34/30 split as split gravity, never external", () => {
    const { finding } = assessMiscentering(
      facts({
        behavior: profile([
          { kinds: { return: 18 }, package: A },
          { kinds: { return: 17 }, package: B },
          { kinds: { return: 15 }, package: C },
        ]),
        referenceShares: shares({ [A]: 36, [B]: 34, [C]: 30 }),
        representationShares: shares({ [A]: 36, [B]: 34, [C]: 30 }),
      })
    );
    expect(finding?.signal).toBe("split-gravity");
  });

  it("skips a consumption-heavy type whose few producers happen to be spread", () => {
    const { outcome } = assessMiscentering(
      facts({
        ...split(),
        behavior: profile([
          { kinds: { "parameter-consumer": 10, return: 2 }, package: A },
          { kinds: { "parameter-consumer": 10, return: 2 }, package: B },
          { kinds: { return: 2 }, package: C },
        ]),
      })
    );
    expect(outcome).toBe("unclear");
  });
});

describe("boundary drift", () => {
  it("emits when the home keeps the symbols while behavior crosses into other packages", () => {
    const { finding } = assessMiscentering(
      facts({
        behavior: profile([
          { kinds: { return: 1 }, package: A },
          { kinds: { return: 2 }, package: B },
          { kinds: { return: 2 }, package: C },
        ]),
        boundaries: [boundary(B)],
        distributionShapes: ["cross-package"],
        referenceShares: shares({ [A]: 5, [B]: 2, [C]: 2 }),
        representationShares: shares({ [A]: 3, [B]: 1, [C]: 1 }),
      })
    );
    expect(finding?.signal).toBe("boundary-drift");
    expect(finding?.supportingFamilies).toEqual([
      "behavioral-locality",
      "boundary-crossing",
    ]);
    expect(finding?.mismatch).toBeLessThan(0);
    expect(finding?.summary).toContain("80% of governing behavior");
  });

  it("needs a second family beside foreign behavior", () => {
    const { outcome } = assessMiscentering(
      facts({
        behavior: profile([
          { kinds: { return: 1 }, package: A },
          { kinds: { return: 2 }, package: B },
          { kinds: { return: 2 }, package: C },
        ]),
        referenceShares: shares({ [A]: 5, [B]: 2, [C]: 2 }),
        representationShares: shares({ [A]: 3, [B]: 1, [C]: 1 }),
      })
    );
    expect(outcome).toBe("unclear");
  });
});

describe("anchors", () => {
  const anchoredHome: AnalysisConfig = {
    ...ANALYSIS_CONFIG,
    anchors: [{ reason: "fixed", target: A }],
  };

  it("keeps the finding and adds a caution when the declared home is anchored", () => {
    const { finding } = assessMiscentering(
      {
        ...external(),
        intent: {
          ...external().intent,
          anchorReason: "fixed",
          seedAnchored: true,
        },
      },
      anchoredHome
    );
    expect(finding?.signal).toBe("external-gravity");
    expect(finding?.anchored).toBe(true);
    expect(finding?.declaredHome.anchorReason).toBe("fixed");
    expect(finding?.cautions[0]).toEqual({
      detail:
        "@t/a is anchored (fixed); treat this as architecture evidence, not a relocation suggestion",
      kind: "declared-home-anchored",
    });
  });

  it("surfaces an anchored observed center", () => {
    const { finding } = assessMiscentering(external(), {
      ...ANALYSIS_CONFIG,
      anchors: [{ target: B }],
    });
    expect(finding?.anchored).toBe(false);
    expect(finding?.observedCenters[0]?.anchored).toBe(true);
    expect(finding?.cautions.map((item) => item.kind)).toEqual([
      "observed-center-anchored",
    ]);
  });
});

describe("report", () => {
  it("orders by confidence then mismatch and counts every outcome", () => {
    const report = findMiscenteredConcepts("@t/a", [
      facts(),
      external(),
      {
        ...external(),
        concept: { ...external().concept, id: "x#Weaker", name: "Weaker" },
        seedImportSites: [],
      },
    ]);
    expect(report.findings.map((item) => item.concept.name)).toEqual([
      "Thing",
      "Weaker",
    ]);
    expect(report.assessed.map((item) => item.outcome)).toEqual([
      "aligned",
      "finding",
      "finding",
    ]);
    expect(report.summary).toEqual({
      anchored: 0,
      bySignal: {
        "boundary-drift": 0,
        "external-gravity": 2,
        "split-gravity": 0,
      },
      evaluated: 3,
      findings: 2,
      outcomes: {
        aligned: 1,
        "behavior-light": 0,
        finding: 2,
        unclear: 0,
        "usage-only": 0,
      },
    });
  });
});
