import { describe, expect, it } from "vitest";
import {
  analyzeArchitecturalReviews,
  compareScenarioImpacts,
  reviewScenarioSet,
} from "../../src/lib/concept-scenario-review";
import type { AnalysisConfig } from "../../src/lib/config";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type {
  BoundaryReduction,
  IntentImpact,
  RecenteringScenarioKind,
  ScenarioBehaviorPlacement,
  ScenarioConstraintImpact,
  ScenarioImpactAnalysis,
  ScenarioImpactFinding,
  ScenarioImpactStatus,
  ScenarioImpactUncertainty,
  ScenarioMetricDelta,
  ScenarioPreservation,
  ScenarioStructuralChange,
} from "../../src/lib/types";

const A = "@t/a";
const B = "@t/b";
const C = "@t/c";
const FINDING = "concept:a:Thing";

const CONCEPT = {
  file: "packages/a/src/thing.ts",
  id: FINDING,
  inTarget: true,
  kind: "interface" as const,
  name: "Thing",
  package: A,
};

interface Overrides {
  added?: string[];
  alignment?: "improves" | "unchanged" | "mixed" | "unknown";
  anchorsViolated?: string[];
  changes?: ScenarioStructuralChange[];
  coLocated?: number;
  constraints?: ScenarioConstraintImpact[];
  depAdded?: number;
  depRemoved?: number;
  depUnmeasured?: string[];
  edges?: number;
  eliminated?: string[];
  governing?: Record<string, number>;
  id?: string;
  implementationRelocated?: string[];
  intent?: IntentImpact["compatibility"];
  pairs?: number;
  parallel?: boolean;
  persistence?: string[];
  preserved?: ScenarioPreservation[];
  reduced?: BoundaryReduction[];
  relocated?: boolean;
  representationAdded?: string[];
  semanticCenter?: string;
  span?: string[];
  status?: ScenarioImpactStatus;
  uncertainties?: ScenarioImpactUncertainty[];
  weak?: Record<string, number>;
}

const CURRENT_SPAN = [A, B];
const CURRENT_GOVERNING: Record<string, number> = { [A]: 2, [B]: 1 };

function metric(
  current: number,
  predicted: number,
  certainty: ScenarioMetricDelta["certainty"] = "certain"
): ScenarioMetricDelta {
  return { certainty, current, delta: predicted - current, predicted };
}

function placements(
  governing: Record<string, number>,
  weak: Record<string, number>
): ScenarioBehaviorPlacement[] {
  const packages = [
    ...new Set([...Object.keys(governing), ...Object.keys(weak)]),
  ].sort();
  return packages.map((pkg) => ({
    conversion: 0,
    governing: governing[pkg] ?? 0,
    implementation: 0,
    package: pkg,
    weak: weak[pkg] ?? 0,
  }));
}

function analysis(
  kind: RecenteringScenarioKind,
  over: Overrides = {}
): ScenarioImpactAnalysis {
  const baselineKind = kind === "preserve-current";
  const span = over.span ?? CURRENT_SPAN;
  const governing = over.governing ?? CURRENT_GOVERNING;
  const semanticCenter = over.semanticCenter ?? A;
  const relocated = over.relocated ?? false;
  const edges = over.edges ?? 1;
  const pairs = over.pairs ?? 0;
  const intent = over.intent ?? "compatible";
  const reduced = over.reduced ?? [];
  const eliminated = over.eliminated ?? [];
  const added = over.added ?? [];
  const id =
    over.id ?? `${FINDING}::${kind}::${semanticCenter}|${span.join("+")}`;
  const changes =
    over.changes ??
    (baselineKind
      ? []
      : [
          {
            certainty: "certain",
            evidence: [],
            kind: "behavior-center-change",
          } satisfies ScenarioStructuralChange,
        ]);
  const currentEdge = {
    conceptImportSites: 2,
    conceptModules: [],
    exclusive: false,
    from: B,
    importSites: 4,
    measured: true,
    to: A,
  };
  return {
    baseline: {
      responsibilities: [
        { packages: [A], responsibility: "semantic-contract" },
      ],
      semanticCenter: A,
    },
    certainty: {
      certain: changes.filter((row) => row.certainty === "certain").length,
      conditional: changes.filter((row) => row.certainty === "conditional")
        .length,
      unknown: (over.uncertainties ?? []).length,
    },
    changes,
    concept: CONCEPT,
    constraints: over.constraints ?? [],
    findingId: FINDING,
    impact: {
      behavior: {
        certainty: "certain",
        consumerBehaviorUnaffected: 0,
        currentByPackage: placements(CURRENT_GOVERNING, {}),
        governingBehaviorPreserved: 3,
        governingBehaviorRelocated: 0,
        governingBehaviorUnplaced: 0,
        packagesAdded: Object.keys(governing).filter(
          (pkg) => CURRENT_GOVERNING[pkg] === undefined
        ),
        packagesRemoved: Object.keys(CURRENT_GOVERNING).filter(
          (pkg) => (governing[pkg] ?? 0) === 0
        ),
        predictedByPackage: placements(governing, over.weak ?? {}),
      },
      boundaries: {
        added,
        conceptModulesDelta: metric(2, 2, "unknown"),
        current: [],
        eliminated,
        importSitesDelta: metric(
          2,
          2 -
            reduced.reduce(
              (sum, row) => sum + row.conceptImportSitesRemoved,
              0
            ),
          "conditional"
        ),
        predicted: [],
        preserved:
          reduced.length + eliminated.length === 0 ? [`${B} → ${A}`] : [],
        reduced,
      },
      dependency: {
        added: Array.from({ length: over.depAdded ?? 0 }, () => ({
          ...currentEdge,
          from: A,
          to: B,
        })),
        currentEdges: [currentEdge],
        packageFanInDelta: metric(1, 1),
        packageFanOutDelta: metric(0, 0),
        predictedEdges: [currentEdge],
        preserved: [currentEdge],
        removed: Array.from(
          { length: over.depRemoved ?? 0 },
          () => currentEdge
        ),
        uncertain: (over.depUnmeasured ?? []).map((edge) => {
          const [from, to] = edge.split(" → ") as [string, string];
          return {
            conceptImportSites: null,
            conceptModules: [],
            exclusive: false,
            from,
            importSites: null,
            measured: false,
            to,
          };
        }),
      },
      evolution: {
        couplingRelationshipsCoLocated: over.coLocated ?? 0,
        couplingRelationshipsPreserved: 0,
        couplingRelationshipsStillCrossBoundary: 0,
        couplingRelationshipsUnknown: 0,
        historicalEvidenceAlignment: over.alignment ?? "unchanged",
        historicallyCoupledFilesAffected: 0,
        hotspotBehaviorRelocated: 0,
      },
      implementation: {
        currentCenters: over.parallel === undefined ? [] : [A, B],
        parallelImplementationPreserved: over.parallel ?? false,
        predictedCenters: over.parallel === undefined ? [] : [A, B],
        preservedImplementations: [],
        relocatedImplementationResponsibility:
          over.implementationRelocated ?? [],
      },
      intent: {
        anchoredResponsibilitiesAdded: [],
        anchoredResponsibilitiesRemoved: [],
        anchorsPreserved: [],
        anchorsViolated: over.anchorsViolated ?? [],
        compatibility: intent,
        publicBoundaryChanges: [],
      },
      locality: {
        behavioralBoundaryEdges: metric(
          1,
          edges,
          edges === 1 ? "certain" : added.length > 0 ? "conditional" : "certain"
        ),
        current: {
          behavioralBoundaryEdges: 1,
          disconnectedPackagePairs: 0,
          maxTraversalDistance: 1,
          shape: "cross-package-localized",
          sourceModuleCount: 3,
          sourcePackageCount: CURRENT_SPAN.length,
          sourcePackages: CURRENT_SPAN,
        },
        disconnectedBehaviorPairs: metric(0, pairs),
        maxTraversalDistance: {
          certainty: baselineKind ? "certain" : "unknown",
          direction: baselineKind ? "unchanged" : "unknown",
        },
        predicted: {
          behavioralBoundaryEdges: edges,
          disconnectedPackagePairs: pairs,
          maxTraversalDistance: baselineKind ? 1 : null,
          sourceModuleCount: baselineKind ? 3 : null,
          sourcePackageCount: span.length,
          sourcePackages: span,
        },
        shapeTransition: {
          certainty: baselineKind ? "certain" : "unknown",
          from: "cross-package-localized",
        },
        sourceModuleCount: baselineKind
          ? metric(3, 3)
          : { certainty: "unknown", current: 3, delta: null, predicted: null },
        sourcePackageCount: metric(CURRENT_SPAN.length, span.length),
      },
      representation: {
        certainty: "certain",
        convertersPreserved: [],
        overlapPairsAffected: [],
        persistenceRepresentationsPreserved: over.persistence ?? [],
        representationBoundariesAdded: over.representationAdded ?? [],
        representationBoundariesRemoved: [],
        semanticRepresentationsCurrent: [],
        semanticRepresentationsPredicted: [],
      },
      surface: {
        currentPublicPackages: [A],
        packagePublicContractRelocated: relocated,
        predictedPublicPackages: relocated ? [semanticCenter] : [A],
        publicExposureAdded: relocated ? [semanticCenter] : [],
        publicExposureRemoved: relocated ? [A] : [],
        ...(relocated && { reexportRequirement: "unknown" as const }),
        consumers: {
          externallyUsed: true,
          impact: relocated ? "unresolved" : "unaffected",
          packagePublic: true,
          packages: [C],
        },
        surfaceCautions: [],
      },
    },
    kind,
    preserved: over.preserved ?? [],
    proposed: {
      responsibilities: [
        { packages: [semanticCenter], responsibility: "semantic-contract" },
        {
          packages: Object.keys(governing).sort(),
          responsibility: "domain-behavior",
        },
      ],
      semanticCenter,
    },
    scenarioId: id,
    status: over.status ?? "simulated",
    summary: [],
    uncertainties: over.uncertainties ?? [],
  };
}

function reduction(edge: string, sites: number): BoundaryReduction {
  return {
    certainty: "conditional",
    conceptImportSitesRemoved: sites,
    conceptInteractionEnds: false,
    edge,
    remainingModules: 1,
  };
}

function conditionalChange(): ScenarioStructuralChange {
  return { certainty: "conditional", evidence: [], kind: "boundary-reduction" };
}

function finding(
  ...scenarios: ScenarioImpactAnalysis[]
): ScenarioImpactFinding {
  return { findingId: FINDING, scenarios, subject: CONCEPT };
}

function review(...scenarios: ScenarioImpactAnalysis[]) {
  return reviewScenarioSet(finding(...scenarios), undefined, ANALYSIS_CONFIG);
}

function statusOf(
  result: ReturnType<typeof review>,
  kind: RecenteringScenarioKind
) {
  const found = result.scenarios.find((row) => row.kind === kind);
  if (!found) {
    throw new Error(`no ${kind}`);
  }
  return found;
}

const baseline = () => analysis("preserve-current");

describe("architectural scenario review", () => {
  it("keeps a tradeoff between locality and surface as multiple-tradeoffs with no dominance", () => {
    const alt = analysis("rehome-semantic-center", {
      edges: 0,
      governing: { [B]: 3 },
      relocated: true,
      semanticCenter: B,
      span: [B],
    });
    const result = review(baseline(), alt);
    expect(result.disposition).toBe("multiple-tradeoffs");
    expect(result.dominated).toEqual([]);
    expect(statusOf(result, "rehome-semantic-center").status).toBe("viable");
    expect(result.viable).toEqual([baseline().scenarioId, alt.scenarioId]);
    const comparison = result.comparisons[0];
    expect(comparison?.result).toBe("tradeoff");
    expect(
      comparison?.dimensions.find((row) => row.dimension === "locality")
        ?.relation
    ).toBe("right-better");
    expect(
      comparison?.dimensions.find((row) => row.dimension === "surface")
        ?.relation
    ).toBe("left-better");
  });

  it("marks the baseline dominated and the finding a credible alternative when a consolidation only gains", () => {
    const alt = analysis("rehome-behavior", {
      changes: [
        { certainty: "certain", evidence: [], kind: "behavior-consolidation" },
        conditionalChange(),
      ],
      edges: 0,
      governing: { [A]: 3 },
      reduced: [reduction(`${B} → ${A}`, 2)],
      span: [A],
    });
    const result = review(baseline(), alt);
    expect(result.disposition).toBe("credible-alternative");
    expect(result.dominated).toEqual([
      {
        dimensions: ["boundary", "locality", "behavior"],
        dominatedBy: alt.scenarioId,
        evidence: [
          "boundary: concept import sites removed 2 vs 0 (conditional)",
          "locality: packages 1 vs 2; behavior edges 0 vs 1 (certain)",
          "behavior: governing behavior packages 1 vs 2 (certain)",
        ],
        scenarioId: baseline().scenarioId,
      },
    ]);
    expect(result.viable).toEqual([alt.scenarioId]);
    expect(statusOf(result, "rehome-behavior").character).toBe(
      "structural-reduction"
    );
    expect(result.rationale[0]).toBe(
      "baseline is dominated by rehome-behavior on boundary, locality, behavior"
    );
  });

  it("marks a pure semantic relocation dominated by the baseline and preserves current", () => {
    const alt = analysis("rehome-semantic-center", {
      relocated: true,
      semanticCenter: B,
    });
    const result = review(baseline(), alt);
    expect(result.disposition).toBe("preserve-current");
    expect(statusOf(result, "rehome-semantic-center")).toMatchObject({
      character: "relocation",
      effects: ["surface-relocation"],
      status: "dominated",
    });
    expect(result.dominated[0]).toMatchObject({
      dimensions: ["surface"],
      dominatedBy: baseline().scenarioId,
      scenarioId: alt.scenarioId,
    });
    expect(result.viable).toEqual([baseline().scenarioId]);
  });

  it("invalidates a structurally strong scenario under intent while keeping its gains visible", () => {
    const alt = analysis("consolidate-behavior", {
      anchorsViolated: [B],
      edges: 0,
      governing: { [A]: 3 },
      intent: "incompatible",
      span: [A],
    });
    const result = review(baseline(), alt);
    expect(result.disposition).toBe("intent-blocked");
    expect(result.invalid).toEqual([alt.scenarioId]);
    expect(result.dominated).toEqual([]);
    const reviewed = statusOf(result, "consolidate-behavior");
    expect(reviewed.status).toBe("invalid");
    expect(reviewed.effects).toContain("intent-conflict");
    expect(reviewed.strengths.map((row) => row.dimension)).toEqual([
      "locality",
      "behavior",
    ]);
    expect(statusOf(result, "preserve-current").costs).toEqual([]);
    expect(result.rationale).toEqual([
      "consolidate-behavior is invalid: violates @t/b",
    ]);
  });

  it("keeps a scenario that must preserve a public contract viable and constrained", () => {
    const alt = analysis("rehome-behavior", {
      constraints: [
        {
          consequence: "consumers keep importing from @t/a",
          constraint: { kind: "public-contract", package: A },
        },
      ],
      edges: 0,
      governing: { [A]: 3 },
      span: [A],
    });
    const result = review(baseline(), alt);
    expect(statusOf(result, "rehome-behavior")).toMatchObject({
      intentCompatibility: "constrained",
      status: "viable",
    });
    expect(
      statusOf(result, "rehome-behavior").costs.map((row) => row.detail)
    ).toEqual(["constrained vs compatible"]);
    expect(result.disposition).toBe("multiple-tradeoffs");
    expect(
      result.comparisons[0]?.dimensions.find(
        (row) => row.dimension === "intent"
      )?.relation
    ).toBe("left-better");
  });

  it("refuses dominance on conditional evidence alone unless the policy relaxes it", () => {
    const alt = analysis("consolidate-behavior", {
      changes: [conditionalChange()],
      reduced: [reduction(`${B} → ${A}`, 3)],
    });
    const strict = review(baseline(), alt);
    expect(strict.comparisons[0]?.result).toBe("insufficient-evidence");
    expect(statusOf(strict, "consolidate-behavior").status).toBe(
      "insufficient-evidence"
    );
    expect(strict.disposition).toBe("insufficient-evidence");
    expect(strict.unresolved).toEqual([
      {
        detail: "differs from the baseline only through boundary (conditional)",
        kind: "conditional-evidence-only",
        scenarioIds: [alt.scenarioId],
      },
    ]);
    const relaxed: AnalysisConfig = {
      ...ANALYSIS_CONFIG,
      recentering: {
        ...ANALYSIS_CONFIG.recentering,
        review: {
          ...ANALYSIS_CONFIG.recentering.review,
          dominance: { requireCertainEvidence: false },
        },
      },
    };
    const loose = reviewScenarioSet(
      finding(baseline(), alt),
      undefined,
      relaxed
    );
    expect(loose.comparisons[0]?.result).toBe("right-dominates");
    expect(loose.disposition).toBe("credible-alternative");
  });

  it("groups scenarios with identical consequences as indistinguishable", () => {
    const first = analysis("rehome-behavior", {
      edges: 0,
      governing: { [A]: 3 },
      span: [A],
    });
    const second = analysis("consolidate-behavior", {
      edges: 0,
      governing: { [A]: 3 },
      span: [A],
    });
    const result = review(baseline(), first, second);
    expect(statusOf(result, "rehome-behavior").status).toBe("viable");
    expect(statusOf(result, "consolidate-behavior").status).toBe(
      "indistinguishable"
    );
    expect(result.unresolved).toEqual([
      {
        detail:
          "consolidate-behavior has the same consequences as rehome-behavior; not a distinct alternative",
        kind: "indistinguishable-scenarios",
        scenarioIds: [first.scenarioId, second.scenarioId],
      },
    ]);
    expect(result.disposition).toBe("credible-alternative");
  });

  it("preserves a healthy persistence split when consolidation only relocates the surface", () => {
    const current = analysis("preserve-current", {
      persistence: ["ThingRow"],
      preserved: [
        { detail: "ThingRow stays in @t/b", kind: "persistence-boundary" },
      ],
    });
    const alt = analysis("rehome-semantic-center", {
      persistence: ["ThingRow"],
      relocated: true,
      semanticCenter: B,
    });
    const result = review(current, alt);
    expect(result.disposition).toBe("preserve-current");
    expect(statusOf(result, "rehome-semantic-center").status).toBe("dominated");
    expect(statusOf(result, "preserve-current").preservations).toEqual([
      {
        certainty: "certain",
        detail: "ThingRow stays in @t/b",
        dimension: "representation",
        kind: "persistence-boundary",
        sourceScenarioId: current.scenarioId,
      },
    ]);
    expect(statusOf(result, "preserve-current").effects).toEqual([
      "representation-preservation",
    ]);
  });

  it("keeps preserve-current viable when an alternative only moves implementation responsibility", () => {
    const current = analysis("preserve-current", { parallel: true });
    const alt = analysis("rehome-behavior", {
      implementationRelocated: [B],
      parallel: false,
    });
    const result = review(current, alt);
    expect(result.comparisons[0]?.result).toBe("tradeoff");
    expect(
      result.comparisons[0]?.dimensions.find(
        (row) => row.dimension === "implementation"
      )
    ).toEqual({
      certainty: "certain",
      dimension: "implementation",
      evidence: [
        "parallel implementations preserved",
        "implementation responsibility relocates from @t/b",
      ],
      relation: "tradeoff",
    });
    expect(result.viable).toContain(current.scenarioId);
    expect(result.dominated).toEqual([]);
  });

  it("returns insufficient-evidence for partially simulated scenarios and names the cause", () => {
    const alt = analysis("rehome-behavior", {
      depUnmeasured: [`${C} → ${B}`],
      edges: 0,
      governing: { [A]: 3 },
      span: [A],
      status: "partially-simulated",
      uncertainties: [
        {
          detail: "conformers unobserved",
          kind: "structural-conformance-unobserved",
        },
      ],
    });
    const result = review(baseline(), alt);
    expect(result.comparisons[0]?.result).toBe("insufficient-evidence");
    expect(statusOf(result, "rehome-behavior")).toMatchObject({
      evidenceCompleteness: "weak",
      status: "insufficient-evidence",
    });
    expect(result.disposition).toBe("insufficient-evidence");
    expect(result.unresolved[0]).toEqual({
      detail: "conformers unobserved; unmeasured edge @t/c → @t/b",
      kind: "partial-simulation",
      scenarioIds: [alt.scenarioId],
    });
    expect(
      statusOf(result, "rehome-behavior").strengths.map((row) => row.dimension)
    ).toEqual(["locality", "behavior"]);
  });

  it("does not grade a span difference made only of parameter consumers", () => {
    const alt = analysis("split-responsibility", {
      span: [A, B, C],
      weak: { [C]: 4 },
    });
    const result = review(baseline(), alt);
    const locality = result.comparisons[0]?.dimensions.find(
      (row) => row.dimension === "locality"
    );
    expect(locality).toEqual({
      certainty: "certain",
      dimension: "locality",
      evidence: [
        "packages 2 vs 3: difference is packages holding only parameter consumption, not graded",
      ],
      relation: "equivalent",
    });
    expect(result.comparisons[0]?.result).toBe("equivalent");
    expect(statusOf(result, "split-responsibility").status).toBe(
      "indistinguishable"
    );
    expect(result.disposition).toBe("preserve-current");
  });

  it("treats historical alignment alone as a tradeoff against a surface cost, never dominance", () => {
    const alt = analysis("rehome-semantic-center", {
      alignment: "improves",
      coLocated: 2,
      relocated: true,
      semanticCenter: B,
    });
    const result = review(baseline(), alt);
    expect(result.comparisons[0]?.result).toBe("tradeoff");
    expect(
      result.comparisons[0]?.dimensions.find(
        (row) => row.dimension === "evolution"
      )
    ).toMatchObject({ certainty: "conditional", relation: "right-better" });
    expect(result.disposition).toBe("multiple-tradeoffs");
    const evolutionOnly = analysis("consolidate-behavior", {
      alignment: "improves",
      coLocated: 2,
    });
    expect(review(baseline(), evolutionOnly).comparisons[0]?.result).toBe(
      "insufficient-evidence"
    );
  });

  it("is independent of input order", () => {
    const semantic = analysis("rehome-semantic-center", {
      relocated: true,
      semanticCenter: B,
    });
    const behavior = analysis("rehome-behavior", {
      edges: 0,
      governing: { [A]: 3 },
      span: [A],
    });
    const forward = review(baseline(), semantic, behavior);
    const backward = review(behavior, semantic, baseline());
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
    expect(forward.scenarios.map((row) => row.kind)).toEqual([
      "preserve-current",
      "rehome-semantic-center",
      "rehome-behavior",
    ]);
  });

  it("carries no score, weight, rank, or plan fields", () => {
    const alt = analysis("rehome-behavior", {
      edges: 0,
      governing: { [A]: 3 },
      span: [A],
    });
    const report = analyzeArchitecturalReviews(
      {
        impacts: {
          findings: [finding(baseline(), alt)],
          summary: {} as never,
          target: A,
        },
        scenarios: { findings: [], summary: {} as never, target: A },
      },
      ANALYSIS_CONFIG
    );
    const keys = new Set<string>();
    JSON.stringify(report, (key, value: unknown) => {
      keys.add(key);
      return value;
    });
    const forbidden =
      /score|weight|fitness|rating|rank|execute|apply|filesToMove|recommend/i;
    expect(
      [...keys].filter(
        (key) => forbidden.test(key) || key === "implement" || key === "plan"
      )
    ).toEqual([]);
    expect(report.summary).toMatchObject({
      credibleAlternative: 1,
      dominatedBaselines: 1,
      findingsReviewed: 1,
      viable: 1,
    });
    expect(report.reviews[0]?.summary).toBe(
      "Thing: external gravity finding; 2 scenarios; 1 viable · 1 dominated · 0 invalid · 0 indistinguishable · 0 insufficient; credible-alternative"
    );
  });

  it("compares two vectors symmetrically", () => {
    const left = analysis("rehome-behavior", {
      edges: 0,
      governing: { [A]: 3 },
      span: [A],
    });
    const right = baseline();
    const forward = compareScenarioImpacts(left, right);
    const backward = compareScenarioImpacts(right, left);
    expect(forward.result).toBe("left-dominates");
    expect(backward.result).toBe("right-dominates");
    expect(
      backward.dimensions.find((row) => row.dimension === "locality")?.relation
    ).toBe("right-better");
  });
});
