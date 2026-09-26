import { KIND_ORDER } from "./concept-scenarios";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  ArchitecturalReviewDimension,
  ArchitecturalReviewEvidence,
  ArchitecturalReviewReport,
  ArchitecturalReviewSummary,
  ArchitecturalReviewUncertainty,
  ArchitecturalScenarioCharacter,
  ArchitecturalScenarioEffect,
  ArchitecturalScenarioReview,
  ArchitecturalTradeoff,
  DominatedScenario,
  ImpactCertainty,
  IntentImpact,
  RecenteringScenarioFinding,
  RecenteringScenarioReport,
  ReviewEvidenceCompleteness,
  ReviewedScenario,
  ReviewedScenarioStatus,
  ScenarioComparison,
  ScenarioDimensionComparison,
  ScenarioDimensionRelation,
  ScenarioImpactAnalysis,
  ScenarioImpactFinding,
  ScenarioImpactReport,
  ScenarioImpactUncertaintyKind,
  ScenarioPreservationKind,
} from "./types";

/** Dimensions that grade a comparison; `uncertainty` is read, never graded. */
const GRADED: ArchitecturalReviewDimension[] = [
  "dependency",
  "boundary",
  "locality",
  "surface",
  "behavior",
  "representation",
  "implementation",
  "evolution",
  "intent",
];

const CERTAINTY_RANK: Record<ImpactCertainty, number> = {
  certain: 0,
  conditional: 1,
  unknown: 2,
};

function worst(...values: ImpactCertainty[]): ImpactCertainty {
  return values.reduce(
    (acc, value) => (CERTAINTY_RANK[value] > CERTAINTY_RANK[acc] ? value : acc),
    "certain"
  );
}

const UNCERTAINTY_DIMENSION: Record<
  ScenarioImpactUncertaintyKind,
  ArchitecturalReviewDimension
> = {
  "composition-root-remains": "behavior",
  "consumer-compatibility-unknown": "surface",
  "historical-future-assumption": "evolution",
  "shared-boundary-edge": "boundary",
  "structural-conformance-unobserved": "implementation",
  "surface-transition-unspecified": "surface",
  "target-module-unknown": "locality",
};

const PRESERVATION_DIMENSION: Record<
  ScenarioPreservationKind,
  ArchitecturalReviewDimension
> = {
  anchor: "intent",
  "consumer-boundary": "dependency",
  "implementation-split": "implementation",
  "persistence-boundary": "representation",
  "public-contract": "surface",
  "semantic-center": "surface",
};

const INTENT_RANK = { compatible: 2, constrained: 1, incompatible: 0 };
const ALIGNMENT_RANK = { improves: 2, mixed: 0, unchanged: 1 };

/**
 * V8.3 intent is anchor-only. A scenario that must preserve a public
 * contract, a representation boundary, or an anchor is `constrained`
 * here; unobserved conformance is evidence completeness, not intent.
 */
function intentOf(item: ScenarioImpactAnalysis): IntentImpact["compatibility"] {
  const declared = item.impact.intent.compatibility;
  if (declared !== "compatible") {
    return declared;
  }
  return item.constraints.some((row) =>
    ["public-contract", "representation-boundary", "anchor"].includes(
      row.constraint.kind
    )
  )
    ? "constrained"
    : "compatible";
}

interface Signal {
  certainty: ImpactCertainty;
  evidence?: string;
  relation: ScenarioDimensionRelation;
}

/** Compare one metric; `null` on either side is an unknown relation. */
function signal(
  label: string,
  left: number | null,
  right: number | null,
  lowerIsBetter: boolean,
  certainty: ImpactCertainty
): Signal {
  if (left === null || right === null) {
    return {
      certainty: "unknown",
      evidence: `${label} ${left ?? "unknown"} vs ${right ?? "unknown"}`,
      relation: "unknown",
    };
  }
  if (left === right) {
    return { certainty: "certain", relation: "equivalent" };
  }
  const leftBetter = lowerIsBetter ? left < right : left > right;
  return {
    certainty,
    evidence: `${label} ${left} vs ${right}`,
    relation: leftBetter ? "left-better" : "right-better",
  };
}

function combine(
  dimension: ArchitecturalReviewDimension,
  signals: Signal[],
  notes: string[] = []
): ScenarioDimensionComparison {
  const evidence = [
    ...signals.flatMap((item) =>
      item.evidence === undefined ? [] : [item.evidence]
    ),
    ...notes,
  ];
  const differing = signals.filter((item) => item.relation !== "equivalent");
  const certainty = worst(...differing.map((item) => item.certainty));
  if (differing.some((item) => item.relation === "unknown")) {
    return { certainty: "unknown", dimension, evidence, relation: "unknown" };
  }
  const left = differing.some((item) => item.relation === "left-better");
  const right = differing.some((item) => item.relation === "right-better");
  const relation: ScenarioDimensionRelation =
    left && right
      ? "tradeoff"
      : left
        ? "left-better"
        : right
          ? "right-better"
          : "equivalent";
  return { certainty, dimension, evidence, relation };
}

function governingPackages(item: ScenarioImpactAnalysis): string[] | null {
  const rows = item.impact.behavior.predictedByPackage;
  if (rows.some((row) => row.governing === null)) {
    return null;
  }
  return rows
    .filter((row) => (row.governing ?? 0) > 0)
    .map((row) => row.package)
    .sort();
}

/** Packages in the predicted span that hold only parameter consumption and construction. */
function weakOnlyPackages(item: ScenarioImpactAnalysis): number {
  const span = new Set(item.impact.locality.predicted.sourcePackages);
  return item.impact.behavior.predictedByPackage.filter(
    (row) =>
      span.has(row.package) &&
      (row.governing ?? 0) +
        (row.implementation ?? 0) +
        (row.conversion ?? 0) ===
        0 &&
      row.weak > 0
  ).length;
}

function sitesRemoved(item: ScenarioImpactAnalysis): number {
  return item.impact.boundaries.reduced.reduce(
    (sum, row) => sum + row.conceptImportSitesRemoved,
    0
  );
}

function boundaryCertainty(item: ScenarioImpactAnalysis): ImpactCertainty {
  return worst(
    "conditional",
    ...item.impact.boundaries.reduced.map((row) => row.certainty)
  );
}

function localityDimension(
  left: ScenarioImpactAnalysis,
  right: ScenarioImpactAnalysis
): ScenarioDimensionComparison {
  const l = left.impact.locality;
  const r = right.impact.locality;
  const spanDelta =
    (l.sourcePackageCount.predicted ?? 0) -
    (r.sourcePackageCount.predicted ?? 0);
  const weakDelta = weakOnlyPackages(left) - weakOnlyPackages(right);
  const notes: string[] = [];
  const signals: Signal[] = [];
  if (spanDelta !== 0 && spanDelta === weakDelta) {
    notes.push(
      `packages ${l.sourcePackageCount.predicted} vs ${r.sourcePackageCount.predicted}: difference is packages holding only parameter consumption, not graded`
    );
  } else {
    signals.push(
      signal(
        "packages",
        l.sourcePackageCount.predicted,
        r.sourcePackageCount.predicted,
        true,
        worst(l.sourcePackageCount.certainty, r.sourcePackageCount.certainty)
      )
    );
  }
  signals.push(
    signal(
      "behavior edges",
      l.behavioralBoundaryEdges.predicted,
      r.behavioralBoundaryEdges.predicted,
      true,
      worst(
        l.behavioralBoundaryEdges.certainty,
        r.behavioralBoundaryEdges.certainty
      )
    ),
    signal(
      "disconnected pairs",
      l.disconnectedBehaviorPairs.predicted,
      r.disconnectedBehaviorPairs.predicted,
      true,
      worst(
        l.disconnectedBehaviorPairs.certainty,
        r.disconnectedBehaviorPairs.certainty
      )
    )
  );
  return combine("locality", signals, notes);
}

function behaviorDimension(
  left: ScenarioImpactAnalysis,
  right: ScenarioImpactAnalysis
): ScenarioDimensionComparison {
  const l = governingPackages(left);
  const r = governingPackages(right);
  const unplaced =
    left.impact.behavior.governingBehaviorUnplaced > 0 ||
    right.impact.behavior.governingBehaviorUnplaced > 0;
  const certainty = unplaced
    ? "unknown"
    : worst(left.impact.behavior.certainty, right.impact.behavior.certainty);
  const row = signal(
    "governing behavior packages",
    l === null ? null : l.length,
    r === null ? null : r.length,
    true,
    certainty
  );
  const notes =
    row.relation === "equivalent" && l !== null && r !== null && !sameList(l, r)
      ? [`governing behavior in ${l.join(", ")} vs ${r.join(", ")}`]
      : [];
  return combine("behavior", [row], notes);
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

function boundaryDimension(
  left: ScenarioImpactAnalysis,
  right: ScenarioImpactAnalysis
): ScenarioDimensionComparison {
  const l = left.impact.boundaries;
  const r = right.impact.boundaries;
  const certainty = worst(boundaryCertainty(left), boundaryCertainty(right));
  return combine("boundary", [
    signal(
      "boundaries eliminated",
      l.eliminated.length,
      r.eliminated.length,
      false,
      certainty
    ),
    signal(
      "concept import sites removed",
      sitesRemoved(left),
      sitesRemoved(right),
      false,
      certainty
    ),
    signal("boundaries added", l.added.length, r.added.length, true, certainty),
  ]);
}

function dependencyDimension(
  left: ScenarioImpactAnalysis,
  right: ScenarioImpactAnalysis
): ScenarioDimensionComparison {
  const l = left.impact.dependency;
  const r = right.impact.dependency;
  const unmeasured = l.uncertain.length > 0 || r.uncertain.length > 0;
  const certainty: ImpactCertainty = unmeasured ? "unknown" : "conditional";
  const notes = unmeasured
    ? [
        `edges with unsettled fate ${l.uncertain.length} vs ${r.uncertain.length}`,
      ]
    : [];
  return combine(
    "dependency",
    [
      signal(
        "package edges removed",
        l.removed.length,
        r.removed.length,
        false,
        certainty
      ),
      signal(
        "package edges added",
        l.added.length,
        r.added.length,
        true,
        certainty
      ),
    ],
    notes
  );
}

function surfaceDimension(
  left: ScenarioImpactAnalysis,
  right: ScenarioImpactAnalysis
): ScenarioDimensionComparison {
  const l = left.impact.surface;
  const r = right.impact.surface;
  const describe = (item: ScenarioImpactAnalysis) =>
    item.impact.surface.packagePublicContractRelocated
      ? `package-public contract relocates ${item.impact.surface.publicExposureRemoved.join(", ")} → ${item.impact.surface.publicExposureAdded.join(", ")}`
      : `package-public contract stays in ${item.baseline.semanticCenter}`;
  const row = signal(
    "public contract relocations",
    l.packagePublicContractRelocated ? 1 : 0,
    r.packagePublicContractRelocated ? 1 : 0,
    true,
    "certain"
  );
  return combine(
    "surface",
    [{ ...row, evidence: undefined }],
    row.relation === "equivalent" ? [] : [describe(left), describe(right)]
  );
}

function representationDimension(
  left: ScenarioImpactAnalysis,
  right: ScenarioImpactAnalysis
): ScenarioDimensionComparison {
  const l = left.impact.representation;
  const r = right.impact.representation;
  const certainty = worst(l.certainty, r.certainty);
  return combine("representation", [
    signal(
      "representation boundaries made explicit",
      l.representationBoundariesAdded.length,
      r.representationBoundariesAdded.length,
      false,
      certainty
    ),
    signal(
      "representation boundaries removed",
      l.representationBoundariesRemoved.length,
      r.representationBoundariesRemoved.length,
      true,
      certainty
    ),
    signal(
      "persistence representations preserved",
      l.persistenceRepresentationsPreserved.length,
      r.persistenceRepresentationsPreserved.length,
      false,
      certainty
    ),
  ]);
}

/** Moving implementation responsibility is context, never a grade: any difference is a tradeoff. */
function implementationDimension(
  left: ScenarioImpactAnalysis,
  right: ScenarioImpactAnalysis
): ScenarioDimensionComparison {
  const l = left.impact.implementation;
  const r = right.impact.implementation;
  const same =
    sameList(
      [...l.relocatedImplementationResponsibility].sort(),
      [...r.relocatedImplementationResponsibility].sort()
    ) &&
    l.parallelImplementationPreserved === r.parallelImplementationPreserved;
  const describe = (item: ScenarioImpactAnalysis) => {
    const impl = item.impact.implementation;
    return impl.relocatedImplementationResponsibility.length > 0
      ? `implementation responsibility relocates from ${impl.relocatedImplementationResponsibility.join(", ")}`
      : impl.parallelImplementationPreserved
        ? "parallel implementations preserved"
        : "implementation centers unchanged";
  };
  return {
    certainty: "certain",
    dimension: "implementation",
    evidence: same ? [] : [describe(left), describe(right)],
    relation: same ? "equivalent" : "tradeoff",
  };
}

function evolutionDimension(
  left: ScenarioImpactAnalysis,
  right: ScenarioImpactAnalysis
): ScenarioDimensionComparison {
  const l = left.impact.evolution;
  const r = right.impact.evolution;
  const rank = (value: typeof l.historicalEvidenceAlignment) =>
    value === "unknown" ? null : ALIGNMENT_RANK[value];
  return combine("evolution", [
    signal(
      "historical alignment",
      rank(l.historicalEvidenceAlignment),
      rank(r.historicalEvidenceAlignment),
      false,
      "conditional"
    ),
    signal(
      "coupled pairs co-located",
      l.couplingRelationshipsCoLocated,
      r.couplingRelationshipsCoLocated,
      false,
      "conditional"
    ),
    signal(
      "coupled pairs still cross-boundary",
      l.couplingRelationshipsStillCrossBoundary,
      r.couplingRelationshipsStillCrossBoundary,
      true,
      "conditional"
    ),
  ]);
}

function intentDimension(
  left: ScenarioImpactAnalysis,
  right: ScenarioImpactAnalysis
): ScenarioDimensionComparison {
  const l = left.impact.intent;
  const r = right.impact.intent;
  const row = signal(
    "intent compatibility",
    INTENT_RANK[intentOf(left)],
    INTENT_RANK[intentOf(right)],
    false,
    "certain"
  );
  const notes =
    row.relation === "equivalent"
      ? []
      : [
          `${intentOf(left)}${l.anchorsViolated.length > 0 ? ` (violates ${l.anchorsViolated.join(", ")})` : ""} vs ${intentOf(right)}${r.anchorsViolated.length > 0 ? ` (violates ${r.anchorsViolated.join(", ")})` : ""}`,
        ];
  return combine("intent", [{ ...row, evidence: undefined }], notes);
}

function uncertaintyDimension(
  left: ScenarioImpactAnalysis,
  right: ScenarioImpactAnalysis
): ScenarioDimensionComparison {
  const kinds = (item: ScenarioImpactAnalysis) =>
    [...new Set(item.uncertainties.map((row) => row.kind))].sort();
  const l = kinds(left);
  const r = kinds(right);
  const same = sameList(l, r);
  return {
    certainty: same ? "certain" : "unknown",
    dimension: "uncertainty",
    evidence: same
      ? []
      : [`${l.join(", ") || "none"} vs ${r.join(", ") || "none"}`],
    relation: same ? "equivalent" : "unknown",
  };
}

/**
 * Pareto comparison of two V8.3 vectors. Dominance needs every graded
 * dimension no worse, no unknown relation, both scenarios fully
 * simulated, and (policy) at least one strict advantage that is certain.
 */
export function compareScenarioImpacts(
  left: ScenarioImpactAnalysis,
  right: ScenarioImpactAnalysis,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ScenarioComparison {
  const dimensions: ScenarioDimensionComparison[] = [
    dependencyDimension(left, right),
    boundaryDimension(left, right),
    localityDimension(left, right),
    surfaceDimension(left, right),
    behaviorDimension(left, right),
    representationDimension(left, right),
    implementationDimension(left, right),
    evolutionDimension(left, right),
    intentDimension(left, right),
    uncertaintyDimension(left, right),
  ];
  const graded = dimensions.filter((row) => GRADED.includes(row.dimension));
  const leftBetter = graded.filter((row) => row.relation === "left-better");
  const rightBetter = graded.filter((row) => row.relation === "right-better");
  const unknown = graded.some((row) => row.relation === "unknown");
  const partial =
    left.status === "partially-simulated" ||
    right.status === "partially-simulated";
  const requireCertain =
    config.recentering.review.dominance.requireCertainEvidence;
  const settle = (): ScenarioComparison["result"] => {
    if (leftBetter.length === 0 && rightBetter.length === 0) {
      if (graded.some((row) => row.relation === "tradeoff")) {
        return "tradeoff";
      }
      return unknown ? "insufficient-evidence" : "equivalent";
    }
    if (partial) {
      return "insufficient-evidence";
    }
    if (
      graded.some((row) => row.relation === "tradeoff") ||
      (leftBetter.length > 0 && rightBetter.length > 0)
    ) {
      return "tradeoff";
    }
    if (unknown) {
      return "insufficient-evidence";
    }
    const winner = leftBetter.length > 0 ? leftBetter : rightBetter;
    if (requireCertain && !winner.some((row) => row.certainty === "certain")) {
      return "insufficient-evidence";
    }
    return leftBetter.length > 0 ? "left-dominates" : "right-dominates";
  };
  return {
    dimensions,
    leftScenarioId: left.scenarioId,
    result: settle(),
    rightScenarioId: right.scenarioId,
  };
}

function completeness(
  item: ScenarioImpactAnalysis
): ReviewEvidenceCompleteness {
  if (item.status !== "simulated") {
    return "weak";
  }
  return item.changes.every((change) => change.certainty === "certain")
    ? "strong"
    : "partial";
}

function effectsOf(
  item: ScenarioImpactAnalysis
): ArchitecturalScenarioEffect[] {
  const { impact } = item;
  const effects: ArchitecturalScenarioEffect[] = [];
  const currentGoverning = new Set(
    impact.behavior.currentByPackage
      .filter((row) => (row.governing ?? 0) > 0)
      .map((row) => row.package)
  );
  const predictedGoverning = governingPackages(item);
  if (
    item.kind !== "preserve-current" &&
    predictedGoverning !== null &&
    predictedGoverning.includes(item.proposed.semanticCenter) &&
    (!currentGoverning.has(item.baseline.semanticCenter) ||
      predictedGoverning.length < currentGoverning.size)
  ) {
    effects.push("center-alignment");
  }
  if (
    (impact.locality.sourcePackageCount.delta ?? 0) < 0 &&
    impact.locality.sourcePackageCount.certainty === "certain"
  ) {
    effects.push("locality-contraction");
  }
  if (
    impact.boundaries.eliminated.length + impact.boundaries.reduced.length >
    0
  ) {
    effects.push("boundary-reduction");
  }
  if (impact.dependency.removed.length > 0) {
    effects.push("dependency-reduction");
  }
  if (
    item.kind === "split-responsibility" ||
    item.kind === "formalize-representation-boundary" ||
    impact.representation.representationBoundariesAdded.length > 0
  ) {
    effects.push("responsibility-clarification");
  }
  if (impact.surface.packagePublicContractRelocated) {
    effects.push("surface-relocation");
  }
  if (
    impact.representation.persistenceRepresentationsPreserved.length > 0 ||
    item.preserved.some((row) => row.kind === "persistence-boundary")
  ) {
    effects.push("representation-preservation");
  }
  if (impact.intent.compatibility === "incompatible") {
    effects.push("intent-conflict");
  }
  return effects;
}

function characterOf(
  item: ScenarioImpactAnalysis,
  effects: ArchitecturalScenarioEffect[],
  versusBaseline: ScenarioComparison | undefined
): ArchitecturalScenarioCharacter {
  if (item.kind === "preserve-current") {
    return "no-change";
  }
  const certainReduction =
    item.impact.boundaries.eliminated.length > 0 ||
    (versusBaseline?.dimensions.some(
      (row) =>
        ["locality", "behavior", "dependency"].includes(row.dimension) &&
        row.relation === "left-better" &&
        row.certainty === "certain"
    ) ??
      false);
  if (certainReduction) {
    return "structural-reduction";
  }
  if (
    effects.includes("center-alignment") ||
    effects.includes("surface-relocation")
  ) {
    return "relocation";
  }
  if (effects.includes("responsibility-clarification")) {
    return "clarification";
  }
  return versusBaseline?.result === "equivalent" ? "no-change" : "relocation";
}

function evidenceRows(
  comparison: ScenarioComparison,
  relation: ScenarioDimensionRelation,
  label: "gain" | "cost" | "change",
  sourceScenarioId: string
): ArchitecturalReviewEvidence[] {
  return comparison.dimensions
    .filter(
      (row) => row.relation === relation && GRADED.includes(row.dimension)
    )
    .map((row) => ({
      certainty: row.certainty,
      detail: row.evidence.join("; "),
      dimension: row.dimension,
      kind: `${row.dimension}-${label}`,
      sourceScenarioId,
    }));
}

function dedupe(
  rows: ArchitecturalReviewEvidence[]
): ArchitecturalReviewEvidence[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.dimension}|${row.detail}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function canonicalOrder(
  scenarios: ScenarioImpactAnalysis[]
): ScenarioImpactAnalysis[] {
  return [...scenarios].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.scenarioId.localeCompare(b.scenarioId)
  );
}

/** Review one finding's scenario set. Pure; input order never changes the result. */
export function reviewScenarioSet(
  finding: ScenarioImpactFinding,
  scenarios: RecenteringScenarioFinding | undefined,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ArchitecturalScenarioReview {
  const ordered = canonicalOrder(finding.scenarios);
  const baseline = ordered.find((item) => item.kind === "preserve-current");
  if (baseline === undefined) {
    throw new Error(`no preserve-current scenario for ${finding.subject.name}`);
  }
  const kindOf = (id: string) =>
    ordered.find((item) => item.scenarioId === id)?.kind ?? id;
  const comparisons: ScenarioComparison[] = [];
  const pair = new Map<string, ScenarioComparison>();
  ordered.forEach((left, i) => {
    for (const right of ordered.slice(i + 1)) {
      const comparison = compareScenarioImpacts(left, right, config);
      comparisons.push(comparison);
      pair.set(`${left.scenarioId}|${right.scenarioId}`, comparison);
    }
  });
  /** The comparison with `left` on the left; recomputed for the reverse orientation so evidence text reads that way. */
  const versus = (
    left: ScenarioImpactAnalysis,
    right: ScenarioImpactAnalysis
  ): ScenarioComparison => {
    const key = `${left.scenarioId}|${right.scenarioId}`;
    const found = pair.get(key);
    if (found !== undefined) {
      return found;
    }
    const computed = compareScenarioImpacts(left, right, config);
    pair.set(key, computed);
    return computed;
  };
  const dominates = (
    left: ScenarioImpactAnalysis,
    right: ScenarioImpactAnalysis
  ): boolean => versus(left, right).result === "left-dominates";
  const equivalent = (
    left: ScenarioImpactAnalysis,
    right: ScenarioImpactAnalysis
  ): boolean => versus(left, right).result === "equivalent";
  const invalid = (item: ScenarioImpactAnalysis) =>
    item.kind !== "preserve-current" &&
    item.impact.intent.compatibility === "incompatible";

  const status = new Map<string, ReviewedScenarioStatus>();
  const dominated: DominatedScenario[] = [];
  const indistinguishable = new Map<string, string>();
  ordered.forEach((item, index) => {
    if (invalid(item)) {
      status.set(item.scenarioId, "invalid");
      return;
    }
    const twin = ordered
      .slice(0, index)
      .find((earlier) => !invalid(earlier) && equivalent(item, earlier));
    if (twin !== undefined) {
      indistinguishable.set(item.scenarioId, twin.scenarioId);
    }
    const dominator = ordered.find(
      (other) => other !== item && !invalid(other) && dominates(other, item)
    );
    if (dominator !== undefined) {
      const rows = versus(dominator, item).dimensions.filter(
        (row) =>
          row.relation === "left-better" && GRADED.includes(row.dimension)
      );
      dominated.push({
        dimensions: rows.map((row) => row.dimension),
        dominatedBy: dominator.scenarioId,
        evidence: rows.map(
          (row) =>
            `${row.dimension}: ${row.evidence.join("; ")} (${row.certainty})`
        ),
        scenarioId: item.scenarioId,
      });
    }
    if (item.kind === "preserve-current") {
      status.set(item.scenarioId, "baseline");
    } else if (twin !== undefined) {
      status.set(item.scenarioId, "indistinguishable");
    } else if (dominator !== undefined) {
      status.set(item.scenarioId, "dominated");
    } else if (
      completeness(item) === "weak" ||
      versus(item, baseline).result === "insufficient-evidence"
    ) {
      status.set(item.scenarioId, "insufficient-evidence");
    } else {
      status.set(item.scenarioId, "viable");
    }
  });

  const baselineDominated = dominated.some(
    (row) => row.scenarioId === baseline.scenarioId
  );
  const alternatives = ordered.filter((item) => item !== baseline);
  const reviewed: ReviewedScenario[] = ordered.map((item) => {
    const effects = effectsOf(item);
    const vsBaseline = item === baseline ? undefined : versus(item, baseline);
    const uncertainties: ArchitecturalReviewEvidence[] = item.uncertainties.map(
      (row) => ({
        certainty: "unknown",
        detail: row.detail,
        dimension: UNCERTAINTY_DIMENSION[row.kind],
        kind: row.kind,
        sourceScenarioId: item.scenarioId,
      })
    );
    const preservations: ArchitecturalReviewEvidence[] = item.preserved.map(
      (row) => ({
        certainty: "certain",
        detail: row.detail,
        dimension: PRESERVATION_DIMENSION[row.kind],
        kind: row.kind,
        sourceScenarioId: item.scenarioId,
      })
    );
    let strengths: ArchitecturalReviewEvidence[];
    let costs: ArchitecturalReviewEvidence[];
    if (vsBaseline === undefined) {
      const graded = alternatives.filter((alt) => !invalid(alt));
      strengths = dedupe(
        graded.flatMap((alt) =>
          evidenceRows(
            versus(baseline, alt),
            "left-better",
            "gain",
            alt.scenarioId
          )
        )
      );
      costs = dedupe(
        graded.flatMap((alt) => [
          ...evidenceRows(
            versus(baseline, alt),
            "right-better",
            "cost",
            alt.scenarioId
          ),
          ...evidenceRows(
            versus(baseline, alt),
            "tradeoff",
            "change",
            alt.scenarioId
          ),
        ])
      );
    } else {
      strengths = evidenceRows(
        vsBaseline,
        "left-better",
        "gain",
        item.scenarioId
      );
      costs = [
        ...evidenceRows(vsBaseline, "right-better", "cost", item.scenarioId),
        ...evidenceRows(vsBaseline, "tradeoff", "change", item.scenarioId),
      ];
    }
    return {
      character: characterOf(item, effects, vsBaseline),
      constraints: item.constraints,
      costs,
      effects,
      evidenceCompleteness: completeness(item),
      intentCompatibility: intentOf(item),
      kind: item.kind,
      preservations,
      scenarioId: item.scenarioId,
      status: status.get(item.scenarioId) ?? "viable",
      strengths,
      uncertainties,
    };
  });

  const tradeoffs: ArchitecturalTradeoff[] = alternatives.map((item) => {
    const comparison = versus(item, baseline);
    const pick = (relation: ScenarioDimensionRelation) =>
      comparison.dimensions
        .filter(
          (row) => row.relation === relation && GRADED.includes(row.dimension)
        )
        .map((row) => ({
          dimension: row.dimension,
          evidence: `${row.evidence.join("; ")} (${row.certainty})`,
        }));
    return {
      costs: [...pick("right-better"), ...pick("tradeoff")],
      gains: pick("left-better"),
      scenarioId: item.scenarioId,
    };
  });

  const viable = [
    ...(baselineDominated || completeness(baseline) === "weak"
      ? []
      : [baseline.scenarioId]),
    ...reviewed
      .filter((row) => row.status === "viable")
      .map((row) => row.scenarioId),
  ];
  const invalidIds = reviewed
    .filter((row) => row.status === "invalid")
    .map((row) => row.scenarioId);

  const unresolved: ArchitecturalReviewUncertainty[] = [];
  const partialIds = ordered
    .filter((item) => item.status === "partially-simulated")
    .map((item) => item.scenarioId);
  if (partialIds.length > 0) {
    const causes = new Set<string>();
    for (const item of ordered) {
      if (item.status !== "partially-simulated") {
        continue;
      }
      for (const row of item.uncertainties) {
        if (row.kind === "structural-conformance-unobserved") {
          causes.add(row.detail);
        }
      }
      for (const edge of item.impact.dependency.uncertain) {
        if (!edge.measured) {
          causes.add(`unmeasured edge ${edge.from} → ${edge.to}`);
        }
      }
    }
    unresolved.push({
      detail: [...causes].sort().join("; ") || "a dimension is unmeasured",
      kind: "partial-simulation",
      scenarioIds: partialIds,
    });
  }
  for (const item of alternatives) {
    if (status.get(item.scenarioId) !== "insufficient-evidence") {
      continue;
    }
    if (item.status === "partially-simulated") {
      continue;
    }
    const conditional = versus(item, baseline).dimensions.filter(
      (row) => row.relation === "left-better" && GRADED.includes(row.dimension)
    );
    if (conditional.length > 0) {
      unresolved.push({
        detail: `differs from the baseline only through ${conditional.map((row) => `${row.dimension} (${row.certainty})`).join(", ")}`,
        kind: "conditional-evidence-only",
        scenarioIds: [item.scenarioId],
      });
    }
  }
  for (const comparison of comparisons) {
    const unknown = comparison.dimensions.filter(
      (row) => row.relation === "unknown" && GRADED.includes(row.dimension)
    );
    if (unknown.length === 0) {
      continue;
    }
    unresolved.push({
      detail: unknown
        .map((row) => `${row.dimension}: ${row.evidence.join("; ")}`)
        .join("; "),
      kind: "unknown-dimension",
      scenarioIds: [comparison.leftScenarioId, comparison.rightScenarioId],
    });
  }
  for (const [id, twin] of indistinguishable) {
    const later = ordered.find((item) => item.scenarioId === id);
    const earlier = ordered.find((item) => item.scenarioId === twin);
    const sameArrangement =
      JSON.stringify(later?.proposed) === JSON.stringify(earlier?.proposed);
    unresolved.push({
      detail: sameArrangement
        ? `${kindOf(id)} has the same consequences as ${kindOf(twin)}; not a distinct alternative`
        : `${kindOf(id)} has the same graded consequences as ${kindOf(twin)}; the arrangements differ only in which package holds the responsibility`,
      kind: "indistinguishable-scenarios",
      scenarioIds: [twin, id],
    });
  }

  const dominatorsOfBaseline = dominated
    .filter((row) => row.scenarioId === baseline.scenarioId)
    .map((row) => row.dominatedBy);
  const viableDominators = alternatives.filter(
    (item) =>
      status.get(item.scenarioId) === "viable" && dominates(item, baseline)
  );
  const viableAlternatives = alternatives.filter(
    (item) => status.get(item.scenarioId) === "viable"
  );
  const dominatorsTradeOff = viableDominators.some((left, i) =>
    viableDominators
      .slice(i + 1)
      .some((right) => versus(left, right).result === "tradeoff")
  );
  const list = (rows: { dimension: ArchitecturalReviewDimension }[]) =>
    rows.length === 0 ? "none" : rows.map((row) => row.dimension).join(", ");
  const rationale: string[] = [];
  let disposition: ArchitecturalScenarioReview["disposition"];
  const [firstDominator] = viableDominators;
  if (alternatives.length === 0) {
    disposition = "preserve-current";
    rationale.push("no alternative scenario was generated");
  } else if (firstDominator !== undefined && !dominatorsTradeOff) {
    disposition = "credible-alternative";
    const row = dominated.find(
      (item) =>
        item.scenarioId === baseline.scenarioId &&
        item.dominatedBy === firstDominator.scenarioId
    );
    rationale.push(
      `baseline is dominated by ${firstDominator.kind} on ${row === undefined ? "graded dimensions" : row.dimensions.join(", ")}`
    );
  } else if (viableAlternatives.length > 0) {
    disposition = "multiple-tradeoffs";
    for (const item of viableAlternatives) {
      const row = tradeoffs.find((t) => t.scenarioId === item.scenarioId);
      rationale.push(
        `${item.kind}: gains ${list(row?.gains ?? [])}; costs ${list(row?.costs ?? [])}`
      );
    }
  } else if (invalidIds.length > 0) {
    disposition = "intent-blocked";
    for (const item of ordered) {
      if (!invalidIds.includes(item.scenarioId)) {
        continue;
      }
      rationale.push(
        `${item.kind} is invalid: ${item.impact.intent.anchorsViolated.length > 0 ? `violates ${item.impact.intent.anchorsViolated.join(", ")}` : "blocked by explicit intent"}`
      );
    }
  } else if (
    reviewed.some((row) => row.status === "insufficient-evidence") ||
    completeness(baseline) === "weak"
  ) {
    disposition = "insufficient-evidence";
    rationale.push(
      "every alternative is dominated, partially simulated, or differs from the baseline only conditionally"
    );
  } else {
    disposition = "preserve-current";
    for (const row of dominated) {
      rationale.push(
        `${kindOf(row.scenarioId)} is dominated by ${kindOf(row.dominatedBy)} on ${row.dimensions.join(", ")}`
      );
    }
    for (const [id, twin] of indistinguishable) {
      rationale.push(`${kindOf(id)} is indistinguishable from ${kindOf(twin)}`);
    }
  }
  if (baselineDominated && disposition !== "credible-alternative") {
    rationale.push(
      `baseline is dominated by ${dominatorsOfBaseline.map(kindOf).join(", ")}`
    );
  }
  for (const id of invalidIds) {
    if (disposition === "intent-blocked") {
      break;
    }
    rationale.push(`${kindOf(id)} is invalid under explicit intent`);
  }

  const counts = (value: ReviewedScenarioStatus) =>
    reviewed.filter((row) => row.status === value).length;
  const signal = scenarios?.signal ?? "external-gravity";
  const summary = `${finding.subject.name}: ${signal.replace("-", " ")} finding; ${ordered.length} scenarios; ${viable.length} viable · ${counts("dominated") + (baselineDominated ? 1 : 0)} dominated · ${counts("invalid")} invalid · ${counts("indistinguishable")} indistinguishable · ${counts("insufficient-evidence")} insufficient; ${disposition}`;

  return {
    baselineScenarioId: baseline.scenarioId,
    comparisons,
    concept: finding.subject,
    disposition,
    dominated,
    findingId: finding.findingId,
    invalid: invalidIds,
    rationale,
    scenarios: reviewed,
    signal,
    summary,
    tradeoffs,
    unresolved,
    viable,
  };
}

/** V8.2 scenarios and V8.3 impacts; anchors and constraints already live in both. */
export interface ArchitecturalReviewSource {
  impacts: ScenarioImpactReport;
  scenarios: RecenteringScenarioReport;
}

/** Review every V8.3 finding. Compositional: no scan, no simulation, no aggregation across findings. */
export function analyzeArchitecturalReviews(
  source: ArchitecturalReviewSource,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ArchitecturalReviewReport {
  const started = performance.now();
  const scenarioFindings = new Map(
    source.scenarios.findings.map((item) => [item.findingId, item])
  );
  const reviews = source.impacts.findings.map((finding) =>
    reviewScenarioSet(finding, scenarioFindings.get(finding.findingId), config)
  );
  return {
    reviews,
    summary: summarize(reviews, performance.now() - started),
    target: source.impacts.target,
  };
}

function summarize(
  reviews: ArchitecturalScenarioReview[],
  runtimeMs: number
): ArchitecturalReviewSummary {
  const disposition = (value: ArchitecturalScenarioReview["disposition"]) =>
    reviews.filter((row) => row.disposition === value).length;
  const scenarios = reviews.flatMap((row) => row.scenarios);
  const status = (value: ReviewedScenarioStatus) =>
    scenarios.filter((row) => row.status === value).length;
  const dominatedBaselines = reviews.filter((row) =>
    row.dominated.some((item) => item.scenarioId === row.baselineScenarioId)
  ).length;
  return {
    credibleAlternative: disposition("credible-alternative"),
    dominated: status("dominated") + dominatedBaselines,
    dominatedBaselines,
    findingsReviewed: reviews.length,
    indistinguishable: status("indistinguishable"),
    insufficientEvidence: disposition("insufficient-evidence"),
    insufficientEvidenceScenarios: status("insufficient-evidence"),
    intentBlocked: disposition("intent-blocked"),
    invalid: status("invalid"),
    multipleTradeoffs: disposition("multiple-tradeoffs"),
    preserveCurrent: disposition("preserve-current"),
    runtimeMs: Math.round(runtimeMs * 100) / 100,
    scenariosReviewed: scenarios.length,
    viable: reviews.reduce((sum, row) => sum + row.viable.length, 0),
  };
}
