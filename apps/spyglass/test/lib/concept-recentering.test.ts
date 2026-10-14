import { describe, expect, it } from "vitest";
import type {
  RecenteringBoundaryUse,
  RecenteringFacts,
} from "../../src/lib/concept-recentering";
import {
  assessRecentering,
  classifyParticipants,
} from "../../src/lib/concept-recentering";
import type { AnalysisConfig } from "../../src/lib/config";

import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type {
  ConceptBehaviorParticipant,
  ConceptFamily,
  ConceptOwnershipTension,
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
  rows: { package: string; kinds: Kinds }[],
  spread: { strongModules?: number; topTwoStrongModuleShare?: number } = {}
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
  const [top] = byPackage;
  return {
    byKind,
    byPackage,
    source: strong + weak,
    strong,
    strongModules: spread.strongModules ?? byPackage.length,
    topTwoStrongModuleShare:
      spread.topTwoStrongModuleShare ?? (strong === 0 ? null : 1),
    weak,
    ...(top !== undefined &&
      top.strong > 0 && { primaryStrongPackage: top.package }),
    primaryStrongShare:
      top === undefined || strong === 0 ? null : top.strong / strong,
  };
}

function tension(
  kind: ConceptOwnershipTension["kind"],
  observedPackage: string,
  value = 0.8
): ConceptOwnershipTension {
  return { kind, observedPackage, seedPackage: A, value };
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
    referenceShares: [{ package: A, share: 1 }],
    relatedFamilies: [],
    representationShares: [{ package: A, share: 1 }],
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

function distributed(
  behavior: RecenteringBehaviorProfile,
  extra: Partial<RecenteringFacts> = {}
): RecenteringFacts {
  const base = facts({ behavior, ...extra });
  return {
    ...base,
    locality: {
      ...base.locality,
      shape: "cross-package-distributed",
      sourceModules: 6,
      sourcePackages: 3,
    },
  };
}

function boundary(
  foreignPackage: string,
  overrides: Partial<RecenteringBoundaryUse> = {}
): RecenteringBoundaryUse {
  return {
    conceptImportedModules: [SEED],
    conceptImportedSitesByModule: [{ importSites: 10, module: SEED }],
    conceptImportingModules: [`packages/${foreignPackage.slice(3)}/src/use.ts`],
    conceptImportSitesByModule: [
      {
        importSites: 10,
        module: `packages/${foreignPackage.slice(3)}/src/use.ts`,
      },
    ],
    destinationModules: 3,
    foreignPackage,
    from: foreignPackage,
    importSites: 50,
    sourceModules: 4,
    to: A,
    ...overrides,
  };
}

const misCentered = () =>
  facts({
    alignment: "divergent",
    behavior: profile([
      { kinds: { "parameter-consumer": 1, return: 8 }, package: B },
      { kinds: { return: 2 }, package: A },
    ]),
    ownershipTensions: [
      tension("seed-vs-representation", B, 0.79),
      tension("seed-vs-behavior", B, 0.82),
    ],
    placement: {
      behaviorPackages: [A, B],
      implementationCenters: [],
      representationCenter: B,
      seedPackage: A,
      semanticCenter: A,
    },
  });

describe("eligibility", () => {
  it("emits nothing without a tension", () => {
    expect(assessRecentering(facts())).toBeUndefined();
  });

  it("reads strong behavior and representation centers in one other package as mis-centered", () => {
    const result = assessRecentering(misCentered());
    expect(result?.status).toBe("candidate");
    expect(result?.shapes).toEqual(["mis-centered", "representation-drift"]);
    expect(result?.dimensions).toEqual(["representation", "behavior"]);
    expect(result?.strongTensions).toEqual([
      "semantic-vs-representation",
      "semantic-vs-behavior",
    ]);
    expect(result?.evidence).toContainEqual({
      dimension: "behavior",
      kind: "semantic-vs-behavior",
      package: B,
      source: "concept-ownership",
      value: 0.82,
    });
  });

  it("keeps one dimension as insufficient evidence with the tension visible", () => {
    const result = assessRecentering(
      facts({
        alignment: "divergent",
        behavior: profile([{ kinds: { return: 6 }, package: B }]),
        ownershipTensions: [tension("seed-vs-behavior", B)],
      })
    );
    expect(result?.status).toBe("insufficient-evidence");
    expect(result?.tensions).toEqual(["semantic-vs-behavior"]);
    expect(result?.shapes).toEqual([]);
  });

  it("never turns the usage center into a tension", () => {
    expect(
      assessRecentering(
        facts({ ownershipTensions: [tension("usage-vs-semantic-center", B)] })
      )
    ).toBeUndefined();
  });

  it("never lets history alone form a candidate", () => {
    const result = assessRecentering(
      facts({
        history: {
          crossPackageCouplings: [
            {
              coChangeCommits: 9,
              left: SEED,
              leftPackage: A,
              right: "packages/b/src/x.ts",
              rightPackage: B,
            },
          ],
          evolutionCenter: B,
          hotspotModules: 2,
          internalSourceCouplings: 3,
        },
        ownershipTensions: [tension("seed-vs-evolution", B, 4)],
      })
    );
    expect(result?.tensions).toEqual([
      "semantic-vs-evolution",
      "temporal-misalignment",
    ]);
    expect(result?.dimensions).toEqual(["evolution"]);
    expect(result?.status).toBe("insufficient-evidence");
  });

  it("applies injected gates", () => {
    const config: AnalysisConfig = {
      ...ANALYSIS_CONFIG,
      recentering: {
        ...ANALYSIS_CONFIG.recentering,
        candidates: { minEvidenceDimensions: 3, minStrongBehaviors: 3 },
      },
    };
    expect(assessRecentering(misCentered(), config)?.status).toBe(
      "insufficient-evidence"
    );
  });
});

describe("behavior strength", () => {
  it("does not read a behavior tension as strong when the observed package mostly accepts the concept", () => {
    const result = assessRecentering(
      facts({
        alignment: "divergent",
        behavior: profile([
          { kinds: { "parameter-consumer": 12, return: 2 }, package: B },
        ]),
        ownershipTensions: [
          tension("seed-vs-representation", B),
          tension("seed-vs-behavior", B),
        ],
      })
    );
    expect(result?.strongTensions).toEqual(["semantic-vs-representation"]);
    expect(result?.shapes).toEqual([]);
    expect(result?.status).toBe("insufficient-evidence");
    expect(result?.cautions.map((item) => item.kind)).toEqual([
      "parameter-consumer-dominated",
      "sparse-strong-behavior",
    ]);
  });
});

describe("scatter", () => {
  const spread = () =>
    profile(
      [
        { kinds: { return: 2 }, package: A },
        { kinds: { return: 2 }, package: B },
        { kinds: { return: 2 }, package: C },
      ],
      { strongModules: 6, topTwoStrongModuleShare: 0.34 }
    );

  it("reads genuinely spread strong behavior with implementation scatter as a candidate", () => {
    const result = assessRecentering(
      distributed(spread(), {
        placement: {
          behaviorPackages: [A, B, C],
          implementationCenters: [A],
          seedPackage: A,
          semanticCenter: A,
        },
      })
    );
    expect(result?.status).toBe("candidate");
    expect(result?.tensions).toEqual([
      "behavioral-scatter",
      "implementation-scatter",
    ]);
    expect(result?.shapes).toEqual([
      "behaviorally-scattered",
      "implementation-drift",
    ]);
  });

  it("refuses scatter when weak behavior dominates", () => {
    const result = assessRecentering(
      distributed(
        profile(
          [
            { kinds: { "parameter-consumer": 10, return: 2 }, package: A },
            { kinds: { "parameter-consumer": 10, return: 2 }, package: B },
          ],
          { strongModules: 4, topTwoStrongModuleShare: 0.5 }
        ),
        { ownershipTensions: [tension("seed-vs-evolution", B, 3)] }
      )
    );
    expect(result?.tensions).toEqual(["semantic-vs-evolution"]);
    expect(result?.cautions.map((item) => item.kind)).toContain(
      "parameter-consumer-dominated"
    );
  });

  it("refuses scatter when two modules hold the strong behavior", () => {
    const result = assessRecentering(
      distributed(
        profile(
          [
            { kinds: { implementation: 40 }, package: A },
            { kinds: { implementation: 40, return: 2 }, package: B },
            { kinds: { return: 2 }, package: C },
          ],
          { strongModules: 5, topTwoStrongModuleShare: 0.95 }
        ),
        { ownershipTensions: [tension("seed-vs-evolution", B, 3)] }
      )
    );
    expect(result?.tensions).toEqual(["semantic-vs-evolution"]);
    expect(result?.cautions.map((item) => item.kind)).toContain(
      "behaviorally-concentrated"
    );
  });
});

describe("boundaries", () => {
  const history = (): RecenteringFacts["history"] => ({
    crossPackageCouplings: [
      {
        coChangeCommits: 5,
        left: SEED,
        leftPackage: A,
        right: "packages/b/src/use.ts",
        rightPackage: B,
      },
    ],
    hotspotModules: 1,
    internalSourceCouplings: 1,
  });

  it("reads a heavy boundary the concept uses on both sides, with coupling across it, as boundary-strained", () => {
    const result = assessRecentering(
      distributed(
        profile(
          [
            { kinds: { return: 3 }, package: A },
            { kinds: { return: 3 }, package: B },
          ],
          { strongModules: 6, topTwoStrongModuleShare: 0.4 }
        ),
        { boundaries: [boundary(B)], history: history() }
      )
    );
    expect(result?.status).toBe("candidate");
    expect(result?.tensions).toEqual([
      "behavioral-scatter",
      "boundary-friction",
      "temporal-misalignment",
    ]);
    expect(result?.shapes).toEqual([
      "behaviorally-scattered",
      "boundary-strained",
    ]);
  });

  it("keeps a localized split on a heavy boundary short of a candidate", () => {
    const result = assessRecentering(
      facts({
        behavior: profile([
          { kinds: { return: 3 }, package: A },
          { kinds: { return: 3 }, package: B },
        ]),
        boundaries: [boundary(B)],
        history: history(),
      })
    );
    expect(result?.tensions).toEqual([
      "boundary-friction",
      "temporal-misalignment",
    ]);
    expect(result?.strongTensions).toEqual([]);
    expect(result?.status).toBe("insufficient-evidence");
  });

  it("does not read a foreign implementation as friction", () => {
    const result = assessRecentering(
      facts({
        behavior: profile([
          { kinds: { implementation: 20 }, package: A },
          { kinds: { implementation: 20 }, package: B },
        ]),
        boundaries: [boundary(B)],
        history: history(),
        placement: {
          behaviorPackages: [A, B],
          implementationCenters: [A, B],
          seedPackage: A,
          semanticCenter: A,
        },
      })
    );
    expect(result?.tensions).toEqual(["temporal-misalignment"]);
  });
});

describe("dependency", () => {
  it("reads a foreign package holding the strong behavior and the seed's imports as dependency misalignment", () => {
    const result = assessRecentering(
      facts({
        alignment: "divergent",
        behavior: profile([
          { kinds: { return: 8 }, package: B },
          { kinds: { return: 1 }, package: A },
        ]),
        ownershipTensions: [tension("seed-vs-behavior", B)],
        seedImportSites: [
          { importSites: 7, package: B },
          { importSites: 3, package: C },
        ],
      })
    );
    expect(result?.tensions).toEqual([
      "semantic-vs-behavior",
      "dependency-misalignment",
    ]);
    expect(result?.shapes).toEqual(["mis-centered"]);
    expect(result?.evidence).toContainEqual({
      dimension: "dependency",
      kind: "dependency-misalignment",
      package: B,
      source: "boundary-interaction",
      value: 0.7,
    });
  });
});

describe("intent", () => {
  it("protects an eligible candidate whose seed package is anchored and keeps its evidence", () => {
    const base = misCentered();
    const result = assessRecentering({
      ...base,
      intent: {
        anchoredObservedPackages: [],
        anchorReason: "kept here",
        representationBoundaries: [],
        seedAnchored: true,
      },
      ownershipTensions: [
        ...base.ownershipTensions,
        tension("anchor-vs-observed-center", B, 2),
      ],
    });
    expect(result?.status).toBe("protected");
    expect(result?.shapes).toEqual([
      "mis-centered",
      "representation-drift",
      "intent-protected",
    ]);
    expect(result?.tensions).toContain("anchor-conflict");
    expect(result?.dimensions).toContain("intent");
    expect(result?.evidence).toContainEqual({
      dimension: "intent",
      kind: "seed-package-anchored",
      package: A,
      source: "anchor",
      value: "kept here",
    });
  });

  it("notes a representation boundary as a caution, never a tension", () => {
    const base = misCentered();
    const result = assessRecentering({
      ...base,
      intent: {
        ...base.intent,
        representationBoundaries: [
          {
            converterPackages: [B],
            explicitBidirectionalConversion: true,
            overlappingConcept: {
              file: "packages/b/src/row.ts",
              id: "packages/b/src/row.ts#ThingRow",
              inTarget: false,
              kind: "interface",
              name: "ThingRow",
              package: B,
            },
            structuralOverlap: 0.8,
          },
        ],
      },
    });
    expect(result?.cautions.map((item) => item.kind)).toContain(
      "representation-boundary"
    );
    expect(result?.tensions).not.toContain("boundary-friction");
  });
});

describe("classifyParticipants", () => {
  const FILE = "packages/a/src/svc.ts";
  function participant(
    symbol: string,
    lines: [number, number],
    role: ConceptBehaviorParticipant["role"] = "contract"
  ): ConceptBehaviorParticipant {
    return {
      file: FILE,
      kind: "source",
      lines: { end: lines[1], start: lines[0] },
      member: symbol.includes(".") ? "method" : "function",
      package: A,
      role,
      symbol,
    };
  }
  const evidence = (
    name: string,
    kind: ConceptFamily["evidence"][number]["kind"],
    line: number
  ): ConceptFamily["evidence"][number] => ({
    file: FILE,
    kind,
    line,
    package: A,
    source: { kind: "function", name, symbolId: `${FILE}#${name}` },
    target: `${SEED}#Thing`,
  });
  const family = {
    evidence: [
      evidence("make", "constructs", 3),
      evidence("make", "return-type", 2),
      evidence("use", "parameter-type", 6),
      evidence("throwIt", "constructs", 10),
      evidence("Svc", "return-type", 21),
      evidence("Svc", "constructs", 25),
      evidence("Svc", "parameter-type", 29),
    ],
  } as unknown as ConceptFamily;

  it("reads each participant by the evidence inside its own lines", () => {
    const result = classifyParticipants(
      family,
      [
        participant("make", [1, 4]),
        participant("use", [5, 8]),
        participant("throwIt", [9, 12]),
        participant("Svc.produce", [20, 22]),
        participant("Svc.fail", [24, 26]),
        participant("Svc.accept", [28, 30]),
        participant("Svc.store", [32, 34], "implementation"),
        participant("toRow", [40, 42]),
      ],
      [{ file: FILE, function: "toRow" }]
    );
    expect(result.map((item) => [item.participant.symbol, item.kind])).toEqual([
      ["make", "return"],
      ["use", "parameter-consumer"],
      ["throwIt", "construction"],
      ["Svc.produce", "return"],
      ["Svc.fail", "construction"],
      ["Svc.accept", "parameter-consumer"],
      ["Svc.store", "implementation"],
      ["toRow", "conversion"],
    ]);
  });
});
