import type {
  DimensionComparison,
  DominanceRelation,
  EffectCertainty,
  EffectDirection,
  FamilyReviewDisposition,
  PackageArchitectureReview,
  PackageArchitectureReviewSummary,
  ReviewDimension,
  ReviewDimensionRole,
  ReviewedEffectDimension,
  ReviewedRewiringScenario,
  ReviewMeasure,
  ScenarioFamilyReview,
  ScenarioReviewStatus,
  ScenarioTradeoff,
  SubjectArchitectureReview,
} from "./architecture-review-types";
import { PACKAGE_ARCHITECTURE_REVIEW_SCHEMA_VERSION } from "./architecture-review-types";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  ClosureSize,
  ConventionAlignment,
  InternalRewiringEffects,
  InternalRewiringReport,
  InternalRewiringScenario,
  InternalRewiringScenarioKind,
  LocalityRelation,
  RewiringPreservation,
  ScenarioFamily,
  ScenarioUncertaintyReason,
} from "./internal-rewiring-types";

// V13.5 package architecture review. A pure function of the V13.4 report:
// every scenario's simulated effects become separate dimensions with a raw
// direction and a certainty; scenarios of one family are compared pairwise;
// dominance holds only over measured differences with no unresolved
// dimension on either side and no required preservation given up. Whatever
// survives is reported as it is: one credible alternative, several that
// trade off, a preservation the evidence requires, or a comparison the
// evidence cannot settle. Nothing is weighted, scored, or ranked.

const DIMENSIONS: ReviewDimension[] = [
  "locality",
  "responsibility-boundaries",
  "dependency-topology",
  "module-composition",
  "surface-indirection",
  "cycles",
  "convention-alignment",
  "movement-closure",
  "preservation",
  "uncertainty",
];

const DIMENSION_ROLES: Record<ReviewDimension, ReviewDimensionRole> = {
  "convention-alignment": "supporting",
  cycles: "comparison",
  "dependency-topology": "comparison",
  locality: "comparison",
  "module-composition": "comparison",
  "movement-closure": "comparison",
  preservation: "blocking",
  "responsibility-boundaries": "comparison",
  "surface-indirection": "comparison",
  uncertainty: "blocking",
};

const COMPARISON_DIMENSIONS = DIMENSIONS.filter(
  (d) => DIMENSION_ROLES[d] === "comparison"
);

const DIMENSION_DEFINITIONS: Record<ReviewDimension, string> = {
  "convention-alignment":
    "whether the proposed placement matches, competes with, or differs from an observed convention; supporting evidence only",
  cycles:
    "cycle membership of the subject module: kept, left, or a potential new cycle",
  "dependency-topology":
    "edges of the affected subgraph, retargeted edges, and the subject module's fan-in and fan-out",
  locality:
    "subject symbols declared where their measured scope places them: inside the responsibility they serve, or at the shared scope their consumers span",
  "module-composition":
    "primary module count, and the scope and role groups of the subject module",
  "movement-closure":
    "same-module declarations the move must carry, may import back, or is blocked by",
  preservation:
    "architectural preservations a preservation scenario of the family asserts; an alternative that gives one up cannot dominate one that keeps it",
  "responsibility-boundaries":
    "primary edges crossing responsibilities, edges with an unresolved endpoint, and subject symbols consumed outside their declaring responsibility",
  "surface-indirection":
    "distinct target modules a consuming responsibility reaches, symbols newly exposed through a surface, and behavior an intermediary would hand to its consumer",
  uncertainty:
    "reasons an effect is conditional or unresolved; unresolved dimensions block dominance in both directions",
};

const CERTAINTY_DEFINITIONS: Record<EffectCertainty, string> = {
  conditional:
    "simulated under a stated assumption (a new module, unresolved consumers, an incomplete closure)",
  measured: "simulated from canonical topology with no open assumption",
  unresolved:
    "cannot be classified until missing evidence is resolvable (a blocked closure, an unplaced target scope); blocks dominance both ways",
};

const UNCERTAINTY_EFFECTS: Partial<
  Record<
    ScenarioUncertaintyReason,
    { dimension: ReviewDimension; certainty: EffectCertainty }
  >
> = {
  "closure-blocked": {
    certainty: "unresolved",
    dimension: "movement-closure",
  },
  "closure-crosses-groups": {
    certainty: "conditional",
    dimension: "movement-closure",
  },
  "composition-role-unclear": {
    certainty: "unresolved",
    dimension: "responsibility-boundaries",
  },
  "movement-closure-incomplete": {
    certainty: "conditional",
    dimension: "movement-closure",
  },
  "target-module-unresolved": {
    certainty: "conditional",
    dimension: "module-composition",
  },
  "unresolved-consumers": {
    certainty: "conditional",
    dimension: "responsibility-boundaries",
  },
};

const STANDING_LIMITATIONS: ScenarioUncertaintyReason[] = [
  "internal-anchors-unavailable",
  "package-public-external-impact",
  "namespace-identity-gap",
  "cycle-membership",
  "composition-root-membership",
  "large-closure",
];

const ARCHITECTURAL_PRESERVATIONS: RewiringPreservation[] = [
  "package-wide-scope",
  "composition-role",
  "cross-responsibility-contract",
];

const PRESERVATION_KINDS: InternalRewiringScenarioKind[] = [
  "preserve-package-primitive",
  "preserve-composition-root",
  "preserve-cross-responsibility-contract",
];

const DISPOSITIONS: FamilyReviewDisposition[] = [
  "preserve-current",
  "credible-alternative",
  "multiple-tradeoffs",
  "preservation-required",
  "uncertainty-blocked",
  "insufficient-evidence",
];

const DISPOSITION_DEFINITIONS: Record<FamilyReviewDisposition, string> = {
  "credible-alternative":
    "exactly one alternative is nondominated with a measured advantage over the baseline; a comparison, not a recommendation",
  "insufficient-evidence":
    "every candidate for the subject was ineligible; nothing to compare",
  "multiple-tradeoffs":
    "two or more alternatives are nondominated with measured advantages on different dimensions; no scenario dominates the others",
  "preservation-required":
    "a preservation scenario holds and no alternative survives with a measured advantage; the broad scope, wiring role, or contract stays",
  "preserve-current":
    "every alternative is dominated or equivalent; the current arrangement stands on the evidence",
  "uncertainty-blocked":
    "no alternative is dominated and none is credible: each has an unresolved dimension, or differs from the baseline only under a condition",
};

const STATUSES: ScenarioReviewStatus[] = [
  "baseline",
  "preservation",
  "credible",
  "uncertain",
  "equivalent",
  "dominated",
  "preservation-conflict",
];

const STATUS_DEFINITIONS: Record<ScenarioReviewStatus, string> = {
  baseline: "the family's reference arrangement",
  credible:
    "nondominated, every dimension resolvable, measured strictly better than the baseline on a dimension or trading measures inside one",
  dominated: "strictly dominated by another scenario of the family",
  equivalent: "nondominated and measured equal to the baseline everywhere",
  preservation: "a preservation scenario; reviewed like any other",
  "preservation-conflict":
    "gives up a preservation a preservation scenario of the family requires",
  uncertain:
    "nondominated, but a dimension is unresolved or its only differences from the baseline are conditional",
};

const DOMINANCE_RULE =
  "A dominates B when neither has an unresolved comparison dimension; on every comparison dimension where they differ both are measured and A is no worse (a mixed dimension is a difference that is not no-worse); A is strictly better on at least one; and A keeps every required preservation B keeps. Convention alignment never bears on dominance.";

const DISPOSITION_PRECEDENCE =
  "insufficient-evidence when no scenario exists; multiple-tradeoffs when two or more alternatives are credible; credible-alternative when one is; preservation-required when a preservation scenario is present; uncertainty-blocked when an alternative is uncertain; otherwise preserve-current";

const ALIGNED: LocalityRelation[] = [
  "declared-in-serving-responsibility",
  "declared-at-shared-scope",
];

const CLOSURE_ORDER: ClosureSize[] = [
  "independent",
  "small",
  "large",
  "unresolved",
];

function sorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function zeroRecord<K extends string>(keys: K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

function measure(
  name: string,
  before: number,
  after: number,
  comparison: ReviewMeasure["comparison"]
): ReviewMeasure {
  return { after, before, comparison, delta: after - before, name };
}

function directionOf(
  measures: ReviewMeasure[],
  certainty: EffectCertainty
): EffectDirection {
  if (certainty === "unresolved") {
    return "unknown";
  }
  const deltas = measures
    .filter((m) => m.comparison !== "none" && m.delta !== 0)
    .map((m) => m.delta);
  if (deltas.length === 0) {
    return "unchanged";
  }
  if (deltas.every((d) => d < 0)) {
    return "reduced";
  }
  if (deltas.every((d) => d > 0)) {
    return "increased";
  }
  return "mixed";
}

const CERTAINTY_ORDER: EffectCertainty[] = [
  "measured",
  "conditional",
  "unresolved",
];

function weaker(a: EffectCertainty, b: EffectCertainty): EffectCertainty {
  return CERTAINTY_ORDER.indexOf(a) >= CERTAINTY_ORDER.indexOf(b) ? a : b;
}

interface FollowedScenario {
  id: string;
  kind: InternalRewiringScenarioKind;
  status: ScenarioReviewStatus | "missing";
}

function dimensionsOf(
  scenario: InternalRewiringScenario,
  behaviorMassOf: (module: string) => number,
  follows: FollowedScenario | undefined
): ReviewedEffectDimension[] {
  const e = scenario.effects;
  const unchanged = changesNothing(scenario);
  const { symbols } = e.locality;
  const aligned = (relation: LocalityRelation) =>
    ALIGNED.includes(relation) ? symbols : 0;
  const [subjectModule] = e.dependencies.modules;
  const { collapse } = scenario.proposed;
  const absorbed =
    collapse === undefined ? 0 : behaviorMassOf(collapse.intermediary);
  const cycleBefore = e.cycles.membership.length;
  let cycleAfter: number;
  if (e.cycles.outcome === "membership-removed") {
    cycleAfter = cycleBefore - 1;
  } else if (e.cycles.outcome === "potential-new-cycle") {
    cycleAfter = cycleBefore + 1;
  } else {
    cycleAfter = cycleBefore;
  }
  let conventionValue: 1 | 2 | 0;
  if (unchanged) {
    conventionValue = 1;
  } else if (e.conventions.alignment === "matches-convention") {
    conventionValue = 2;
  } else if (e.conventions.alignment === "differs-from-convention") {
    conventionValue = 0;
  } else {
    conventionValue = 1;
  }
  const { closure } = scenario;
  const measures: Record<ReviewDimension, ReviewMeasure[]> = {
    "convention-alignment": [
      measure("conventionMatch", 1, conventionValue, "higher"),
    ],
    cycles: [measure("cycleRisk", cycleBefore, cycleAfter, "lower")],
    "dependency-topology": [
      measure(
        "edges",
        e.dependencies.edgesRemoved + e.dependencies.edgesRetargeted,
        e.dependencies.edgesRetargeted + e.dependencies.edgesAdded,
        "lower"
      ),
      measure("retargetedEdges", 0, e.dependencies.edgesRetargeted, "none"),
      ...(subjectModule === undefined
        ? []
        : [
            measure(
              "fanIn",
              subjectModule.fanIn.before,
              subjectModule.fanIn.after,
              "none"
            ),
            measure(
              "fanOut",
              subjectModule.fanOut.before,
              subjectModule.fanOut.after,
              "none"
            ),
          ]),
    ],
    locality: [
      measure(
        "alignedSymbols",
        aligned(e.locality.before),
        aligned(e.locality.after),
        "higher"
      ),
    ],
    "module-composition": [
      measure(
        "modules",
        e.moduleComposition.modules.before,
        e.moduleComposition.modules.after,
        "lower"
      ),
      measure(
        "scopeGroups",
        e.moduleComposition.scopeGroups.before,
        e.moduleComposition.scopeGroups.after,
        "lower"
      ),
      measure(
        "roleGroups",
        e.moduleComposition.roleGroups.before,
        e.moduleComposition.roleGroups.after,
        "lower"
      ),
    ],
    "movement-closure": [
      measure("required", 0, closure?.required.length ?? 0, "lower"),
      measure("blockers", 0, closure?.blockers.length ?? 0, "lower"),
      measure("optional", 0, closure?.optional.length ?? 0, "none"),
      measure("movedSymbols", 0, closure?.subject.length ?? 0, "none"),
    ],
    preservation: [],
    "responsibility-boundaries": [
      measure(
        "crossEdges",
        e.responsibilityBoundaries.crossEdges.before,
        e.responsibilityBoundaries.crossEdges.after,
        "lower"
      ),
      measure(
        "unresolvedEdges",
        e.responsibilityBoundaries.unresolvedEdges.before,
        e.responsibilityBoundaries.unresolvedEdges.after,
        "lower"
      ),
      measure(
        "crossingSymbols",
        e.responsibilityBoundaries.crossingSymbols.before,
        e.responsibilityBoundaries.crossingSymbols.after,
        "lower"
      ),
      measure(
        "withinEdges",
        e.responsibilityBoundaries.withinEdges.before,
        e.responsibilityBoundaries.withinEdges.after,
        "none"
      ),
    ],
    "surface-indirection": [
      ...(e.dependencies.deepImports === undefined
        ? []
        : [
            measure(
              "deepImports",
              e.dependencies.deepImports.before,
              e.dependencies.deepImports.after,
              "lower"
            ),
          ]),
      ...(scenario.proposed.surface === undefined
        ? []
        : [
            measure(
              "surfaceSymbols",
              0,
              scenario.proposed.surface.symbolIds.length,
              "lower"
            ),
          ]),
      ...(collapse === undefined
        ? []
        : [measure("absorbedStatements", 0, absorbed, "none")]),
    ],
    uncertainty: [],
  };
  const certainty = Object.fromEntries(
    DIMENSIONS.map((d): [ReviewDimension, EffectCertainty] => [d, "measured"])
  ) as Record<ReviewDimension, EffectCertainty>;
  const conditions = Object.fromEntries(
    DIMENSIONS.map((d) => [d, [] as string[]])
  ) as Record<ReviewDimension, string[]>;
  dimensionsOfEntries(
    unchanged,
    scenario,
    certainty,
    conditions,
    e,
    absorbed,
    follows,
    measures
  );
  // A scenario that changes nothing is unchanged and measured on every dimension; nothing to carry.
  if (unchanged) {
    return [];
  }
  return DIMENSIONS.filter((d) => DIMENSION_ROLES[d] !== "blocking").map(
    (dimension) => ({
      certainty: certainty[dimension],
      conditions: conditions[dimension],
      dimension,
      direction: directionOf(measures[dimension], certainty[dimension]),
      measures: measures[dimension],
    })
  );
}

function dimensionsOfEntries(
  unchanged: boolean,
  scenario: InternalRewiringScenario,
  certainty: Record<ReviewDimension, EffectCertainty>,
  conditions: Record<ReviewDimension, string[]>,
  e: InternalRewiringEffects,
  absorbed: number,
  follows: FollowedScenario | undefined,
  measures: Record<ReviewDimension, ReviewMeasure[]>
) {
  if (!unchanged) {
    for (const u of scenario.uncertainties) {
      const effect = UNCERTAINTY_EFFECTS[u.reason];
      if (effect === undefined) {
        continue;
      }
      certainty[effect.dimension] = weaker(
        certainty[effect.dimension],
        effect.certainty
      );
      conditions[effect.dimension].push(`${u.reason}: ${u.detail}`);
    }
    const { unresolvedEdges } = e.responsibilityBoundaries;
    if (
      unresolvedEdges.after > unresolvedEdges.before &&
      scenario.proposed.responsibility === undefined &&
      (scenario.proposed.scope === "package-wide" ||
        scenario.proposed.scope === "cross-responsibility")
    ) {
      certainty["responsibility-boundaries"] = "unresolved";
      conditions["responsibility-boundaries"].push(
        "unresolved-edge artifact: the target scope has no responsibility, so edges into it cannot be classified as within or cross"
      );
    }
    if (absorbed > 0) {
      certainty["module-composition"] = weaker(
        certainty["module-composition"],
        "conditional"
      );
      conditions["module-composition"].push(
        `the intermediary's ${absorbed} statements move to its consumer`
      );
    }
    dimensionsOfEntriesEntries(follows, measures, certainty, conditions);
  }
}

function dimensionsOfEntriesEntries(
  follows: FollowedScenario | undefined,
  measures: Record<ReviewDimension, ReviewMeasure[]>,
  certainty: Record<ReviewDimension, EffectCertainty>,
  conditions: Record<ReviewDimension, string[]>
) {
  if (follows !== undefined && follows.status !== "credible") {
    for (const dimension of COMPARISON_DIMENSIONS) {
      if (directionOf(measures[dimension], "measured") === "unchanged") {
        continue;
      }
      certainty[dimension] = weaker(certainty[dimension], "conditional");
      conditions[dimension].push(
        `follows ${follows.kind} ${follows.id}, which is ${follows.status}`
      );
    }
  }
}

function effectOf(
  reviewed: ReviewedEffectDimension[],
  dimension: ReviewDimension
): ReviewedEffectDimension {
  return (
    reviewed.find((d) => d.dimension === dimension) ?? {
      certainty: "measured",
      conditions: [],
      dimension,
      direction: "unchanged",
      measures: [],
    }
  );
}

function compareDimension(
  a: ReviewedEffectDimension,
  b: ReviewedEffectDimension
): DimensionComparison {
  if (a.certainty === "unresolved" || b.certainty === "unresolved") {
    return "incomparable";
  }
  const names = sorted([
    ...a.measures.filter((m) => m.comparison !== "none").map((m) => m.name),
    ...b.measures.filter((m) => m.comparison !== "none").map((m) => m.name),
  ]);
  let better = 0;
  let worse = 0;
  for (const name of names) {
    const left = a.measures.find((m) => m.name === name);
    const right = b.measures.find((m) => m.name === name);
    const comparison = left?.comparison ?? right?.comparison ?? "none";
    const dl = left?.delta ?? 0;
    const dr = right?.delta ?? 0;
    if (dl === dr) {
      continue;
    }
    const leftLower = dl < dr;
    if (comparison === "lower" ? leftLower : !leftLower) {
      better += 1;
    } else {
      worse += 1;
    }
  }
  if (better === 0 && worse === 0) {
    return "equal";
  }
  if (worse === 0) {
    return "better";
  }
  if (better === 0) {
    return "worse";
  }
  return "mixed";
}

interface Reviewed {
  effects: ReviewedEffectDimension[];
  scenario: InternalRewiringScenario;
}

function dominates(
  a: Reviewed,
  b: Reviewed,
  required: RewiringPreservation[]
): ReviewDimension[] | undefined {
  const improves: ReviewDimension[] = [];
  for (const dimension of COMPARISON_DIMENSIONS) {
    const left = effectOf(a.effects, dimension);
    const right = effectOf(b.effects, dimension);
    const comparison = compareDimension(left, right);
    if (comparison === "incomparable") {
      return undefined;
    }
    if (comparison === "equal") {
      continue;
    }
    if (comparison !== "better") {
      return undefined;
    }
    if (left.certainty !== "measured" || right.certainty !== "measured") {
      return undefined;
    }
    improves.push(dimension);
  }
  if (improves.length === 0) {
    return undefined;
  }
  const keptA = keptPreservations(a.scenario, required);
  const keptB = keptPreservations(b.scenario, required);
  if (required.some((p) => keptB.includes(p) && !keptA.includes(p))) {
    return undefined;
  }
  return improves;
}

/** The baseline and the preservation scenarios: nothing moves. */
function changesNothing(scenario: InternalRewiringScenario): boolean {
  return (
    scenario.proposed.scope === "unchanged" ||
    PRESERVATION_KINDS.includes(scenario.kind)
  );
}

/** A scenario that changes nothing holds every requirement by definition. */
function keptPreservations(
  scenario: InternalRewiringScenario,
  required: RewiringPreservation[]
): RewiringPreservation[] {
  return changesNothing(scenario)
    ? sorted([...scenario.preservations, ...required])
    : scenario.preservations;
}

export function reviewPackageArchitecture(
  rewiring: InternalRewiringReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): PackageArchitectureReview {
  const policy = config.internalReview;
  const scenarioById = new Map(rewiring.scenarios.map((s) => [s.id, s]));
  const compositionByModule = new Map(
    rewiring.composition.map((c) => [c.module, c])
  );
  const behaviorMassOf = (module: string) =>
    compositionByModule.get(module)?.behaviorMass ?? 0;
  const statusById = new Map<string, ScenarioReviewStatus>();
  // A redirect follows a placement scenario of another family; it is
  // reviewed after that family so its certainty can depend on the outcome.
  const followedBy = (scenario: InternalRewiringScenario) => {
    const fact = scenario.rationale.facts.find((f) => f.startsWith("follows "));
    if (fact === undefined) {
      return;
    }
    const id = fact.slice("follows ".length);
    const followed = scenarioById.get(id);
    return {
      id,
      kind: followed?.kind ?? scenario.kind,
      status: statusById.get(id) ?? ("missing" as const),
    };
  };
  const followsAnother = (family: InternalRewiringReport["families"][number]) =>
    family.scenarioIds.some(
      (id) =>
        scenarioById
          .get(id)
          ?.rationale.facts.some((f) => f.startsWith("follows ")) === true
    );

  const families: ScenarioFamilyReview[] = [];
  const scenarios: ReviewedRewiringScenario[] = [];
  const pairCounts = {
    alternativeOverAlternative: 0,
    alternativeOverBaseline: 0,
    baselineOverAlternative: 0,
    noDominance: 0,
  };
  const tradeoffPairCounts = new Map<string, number>();

  const passes = [
    rewiring.families.filter((f) => !followsAnother(f)),
    rewiring.families.filter((f) => followsAnother(f)),
  ];
  reviewPackageArchitectureFamily(
    passes,
    scenarioById,
    behaviorMassOf,
    followedBy,
    pairCounts,
    scenarios,
    statusById,
    tradeoffPairCounts,
    families
  );

  // Subjects whose every candidate was ineligible: reviewed as families with nothing to compare.
  const familyKeys = new Set(families.map((f) => f.id));
  const ineligible = new Map<
    string,
    {
      subject: ScenarioFamilyReview["subject"];
      missing: string[];
      reasons: string[];
    }
  >();
  for (const candidate of rewiring.candidates) {
    if (
      candidate.eligibility.eligible ||
      familyKeys.has(candidate.subject.key)
    ) {
      continue;
    }
    const entry = ineligible.get(candidate.subject.key) ?? {
      missing: [],
      reasons: [],
      subject: candidate.subject,
    };
    entry.missing.push(
      ...candidate.eligibility.missingEvidence.map(
        (m) => `${candidate.kind}: ${m}`
      )
    );
    entry.reasons.push(...candidate.eligibility.reasons);
    ineligible.set(candidate.subject.key, entry);
  }
  for (const [key, entry] of ineligible) {
    families.push({
      disposition: "insufficient-evidence",
      dominance: [],
      dominated: [],
      id: key,
      missingEvidence: sorted(entry.missing),
      nondominated: [],
      preservationRequirements: [],
      reasons: sorted(entry.reasons),
      scenarios: [],
      subject: entry.subject,
      tradeoffs: [],
    });
  }
  families.sort((a, b) => a.id.localeCompare(b.id));
  const position = new Map<string, number>();
  families.forEach((family, i) => {
    family.scenarios.forEach((id, j) => {
      position.set(id, i * 1000 + j);
    });
  });
  scenarios.sort(
    (a, b) =>
      (position.get(a.scenarioId) ?? 0) - (position.get(b.scenarioId) ?? 0)
  );

  const subjects = buildSubjects(families, scenarios, rewiring, policy);
  const summary = summarize(
    families,
    scenarios,
    subjects,
    pairCounts,
    tradeoffPairCounts,
    scenarioById
  );

  return {
    families,
    limitations: [
      "effects are the V13.4 simulations; the review compares them and reads nothing else",
      "a reduction is a direction, not an improvement: dimensions are compared separately and never weighted against each other",
      "a package-public symbol's external consumers are outside the package boundary; every V13.4 movement keeps the symbol's public exposure, so the unevaluated external impact is recorded, not compared",
      "no internal anchor model: an intentional boundary cannot be told from an incidental one; recorded on every movement, never compared",
      "a promoted symbol's target scope has no responsibility, so its boundary effect is unresolved and blocks dominance both ways",
      "a credible alternative is a comparison result, not a recommendation, a plan, or a readiness claim",
    ],
    package: rewiring.package,
    policy: {
      architecturalPreservations: ARCHITECTURAL_PRESERVATIONS,
      certainty: CERTAINTY_DEFINITIONS,
      comparisonScope: "within scenario family",
      complexSubject: policy.complexSubject,
      dimensionDefinitions: DIMENSION_DEFINITIONS,
      dimensionRoles: DIMENSION_ROLES,
      dimensions: DIMENSIONS,
      dispositionDefinitions: DISPOSITION_DEFINITIONS,
      dispositionPrecedence: DISPOSITION_PRECEDENCE,
      dispositions: DISPOSITIONS,
      dominance: DOMINANCE_RULE,
      ranking: "none",
      score: "none",
      severity: "none",
      standingLimitations: STANDING_LIMITATIONS,
      statusDefinitions: STATUS_DEFINITIONS,
      statuses: STATUSES,
      uncertaintyEffects: UNCERTAINTY_EFFECTS,
    },
    scenarios,
    schemaVersion: PACKAGE_ARCHITECTURE_REVIEW_SCHEMA_VERSION,
    subjects,
    summary,
  };
}

function reviewPackageArchitectureFamily(
  passes: ScenarioFamily[][],
  scenarioById: Map<string, InternalRewiringScenario>,
  behaviorMassOf: (module: string) => number,
  followedBy: (scenario: InternalRewiringScenario) =>
    | {
        id: string;
        kind: InternalRewiringScenarioKind;
        status: ScenarioReviewStatus | "missing";
      }
    | undefined,
  pairCounts: {
    alternativeOverAlternative: number;
    alternativeOverBaseline: number;
    baselineOverAlternative: number;
    noDominance: number;
  },
  scenarios: ReviewedRewiringScenario[],
  statusById: Map<string, ScenarioReviewStatus>,
  tradeoffPairCounts: Map<string, number>,
  families: ScenarioFamilyReview[]
) {
  for (const family of passes.flat()) {
    const members: Reviewed[] = family.scenarioIds
      .map((id) => scenarioById.get(id))
      .filter((s): s is InternalRewiringScenario => s !== undefined)
      .map((scenario) => ({
        effects: dimensionsOf(scenario, behaviorMassOf, followedBy(scenario)),
        scenario,
      }));
    const baseline =
      members.find((m) => m.scenario.kind === "preserve-current") ??
      members.find((m) => PRESERVATION_KINDS.includes(m.scenario.kind));
    const required = sorted(
      members
        .filter((m) => PRESERVATION_KINDS.includes(m.scenario.kind))
        .flatMap((m) => m.scenario.preservations)
        .filter((p) => ARCHITECTURAL_PRESERVATIONS.includes(p))
    );
    const dominance: DominanceRelation[] = [];
    const dominatedBy = new Map<string, string[]>();
    const dominatesMap = new Map<string, string[]>();
    reviewPackageArchitectureFamilyA(
      members,
      required,
      dominance,
      dominatedBy,
      dominatesMap
    );
    const isBaseline = (m: Reviewed) => m === baseline;
    const isAlternative = (m: Reviewed) =>
      !(isBaseline(m) || PRESERVATION_KINDS.includes(m.scenario.kind));
    reviewPackageArchitectureFamilyI(
      members,
      dominatedBy,
      pairCounts,
      isBaseline,
      isAlternative
    );

    const reviewedMembers: ReviewedRewiringScenario[] = members.map((m) => {
      const kept = keptPreservations(m.scenario, required);
      const missing = required.filter((p) => !kept.includes(p));
      const conditional = m.effects
        .filter((d) => d.certainty === "conditional")
        .map((d) => d.dimension);
      const unresolved = m.effects
        .filter((d) => d.certainty === "unresolved")
        .map((d) => d.dimension);
      const advantages: ReviewDimension[] = [];
      const costs: ReviewDimension[] = [];
      const mixed: ReviewDimension[] = [];
      let conditionalDifference = false;
      if (baseline !== undefined && m !== baseline) {
        const visitDimension = () => {
          conditionalDifference = collectDimension(
            m,
            baseline,
            advantages,
            costs,
            mixed,
            conditionalDifference
          );
        };
        visitDimension();
      }
      const status: ScenarioReviewStatus = reviewPackageArchitectureEntries(
        isBaseline,
        m,
        missing,
        dominatedBy,
        unresolved,
        advantages,
        mixed,
        conditionalDifference
      );
      const reasons = m.scenario.uncertainties.map((u) => u.reason);
      return {
        dominatedBy: sorted(dominatedBy.get(m.scenario.id) ?? []),
        dominates: sorted(dominatesMap.get(m.scenario.id) ?? []),
        effects: m.effects,
        familyId: family.subject.key,
        kind: m.scenario.kind,
        measuredAdvantages: advantages,
        measuredCosts: costs,
        measuredTradeoffs: mixed,
        preservation: { kept, missing, required },
        scenarioId: m.scenario.id,
        status,
        uncertainty: {
          conditionalDimensions: conditional,
          reasons,
          standing: reasons.filter((r) => STANDING_LIMITATIONS.includes(r)),
          unresolvedDimensions: unresolved,
        },
        ...(m.scenario.closure !== undefined && {
          closure: m.scenario.closure.size,
        }),
        evidence: { scenario: m.scenario.id },
      };
    });
    scenarios.push(...reviewedMembers);
    for (const r of reviewedMembers) {
      statusById.set(r.scenarioId, r.status);
    }

    const nondominated = reviewedMembers
      .filter((r) => r.dominatedBy.length === 0)
      .map((r) => r.scenarioId);
    const tradeoffs: ScenarioTradeoff[] = [];
    const nondominatedMembers = members.filter((m) =>
      nondominated.includes(m.scenario.id)
    );
    reviewPackageArchitectureFamilyI2(
      nondominatedMembers,
      tradeoffs,
      tradeoffPairCounts
    );

    const alternatives = reviewedMembers.filter(
      (r) => r.status !== "baseline" && r.status !== "preservation"
    );
    const credible = alternatives.filter((r) => r.status === "credible");
    const uncertain = alternatives.filter((r) => r.status === "uncertain");
    const hasPreservation = members.some((m) =>
      PRESERVATION_KINDS.includes(m.scenario.kind)
    );

    const reasons: string[] = [];
    const describe = (r: ReviewedRewiringScenario) =>
      `${r.kind}: ${[
        ...(r.measuredAdvantages.length > 0
          ? [`better on ${r.measuredAdvantages.join(", ")}`]
          : []),
        ...(r.measuredCosts.length > 0
          ? [`worse on ${r.measuredCosts.join(", ")}`]
          : []),
        ...(r.measuredTradeoffs.length > 0
          ? [`trades inside ${r.measuredTradeoffs.join(", ")}`]
          : []),
        ...(r.uncertainty.conditionalDimensions.length > 0
          ? [`conditional on ${r.uncertainty.conditionalDimensions.join(", ")}`]
          : []),
      ].join("; ")}`;
    const disposition: FamilyReviewDisposition =
      reviewPackageArchitectureFamilyEntries(
        credible,
        reasons,
        describe,
        hasPreservation,
        required,
        uncertain,
        alternatives
      );
    if (baseline !== undefined) {
      const baselineDominated = dominatedBy.get(baseline.scenario.id) ?? [];
      if (baselineDominated.length > 0) {
        reasons.push(
          `baseline dominated by ${baselineDominated.map((id) => scenarioById.get(id)?.kind ?? id).join(", ")}`
        );
      }
    }
    families.push({
      id: family.subject.key,
      subject: family.subject,
      ...(baseline !== undefined && {
        baseline: baseline.scenario.id,
        baselineKind: baseline.scenario.kind,
      }),
      disposition,
      dominance,
      dominated: reviewedMembers
        .filter((r) => r.dominatedBy.length > 0)
        .map((r) => r.scenarioId),
      missingEvidence: [],
      nondominated,
      preservationRequirements: required,
      reasons,
      scenarios: family.scenarioIds,
      tradeoffs,
    });
  }
}

function reviewPackageArchitectureFamilyA(
  members: Reviewed[],
  required: RewiringPreservation[],
  dominance: DominanceRelation[],
  dominatedBy: Map<string, string[]>,
  dominatesMap: Map<string, string[]>
) {
  for (const a of members) {
    for (const b of members) {
      if (a === b) {
        continue;
      }
      const improves = dominates(a, b, required);
      if (improves === undefined) {
        continue;
      }
      dominance.push({
        dominant: a.scenario.id,
        dominated: b.scenario.id,
        improves,
      });
      dominatedBy.set(b.scenario.id, [
        ...(dominatedBy.get(b.scenario.id) ?? []),
        a.scenario.id,
      ]);
      dominatesMap.set(a.scenario.id, [
        ...(dominatesMap.get(a.scenario.id) ?? []),
        b.scenario.id,
      ]);
    }
  }
}

function reviewPackageArchitectureFamilyEntries(
  credible: ReviewedRewiringScenario[],
  reasons: string[],
  describe: (r: ReviewedRewiringScenario) => string,
  hasPreservation: boolean,
  required: RewiringPreservation[],
  uncertain: ReviewedRewiringScenario[],
  alternatives: ReviewedRewiringScenario[]
): FamilyReviewDisposition {
  let disposition: FamilyReviewDisposition;
  if (credible.length >= 2) {
    disposition = "multiple-tradeoffs";
    reasons.push(
      `${credible.length} alternatives nondominated with measured differences`,
      ...credible.map(describe),
      "no scenario dominates the others on all measured dimensions"
    );
  } else if (credible.length === 1) {
    disposition = "credible-alternative";
    const [only] = credible;
    if (only !== undefined) {
      reasons.push(`nondominated · ${describe(only)}`);
    }
  } else if (hasPreservation) {
    disposition = "preservation-required";
    reasons.push(
      `preservation scenario present; requires ${required.length > 0 ? required.join(", ") : "nothing architectural"}`
    );
    if (uncertain.length > 0) {
      reasons.push(
        `${uncertain.length} alternatives uncertain: ${uncertain.map((r) => `${r.kind} (${[...r.uncertainty.unresolvedDimensions, ...r.uncertainty.conditionalDimensions].join(", ")})`).join("; ")}`
      );
    }
  } else if (uncertain.length > 0) {
    disposition = "uncertainty-blocked";
    reasons.push(
      `${uncertain.length} alternatives nondominated but not comparable: ${uncertain.map((r) => `${r.kind} (${[...r.uncertainty.unresolvedDimensions.map((d) => `${d} unresolved`), ...r.uncertainty.conditionalDimensions.map((d) => `${d} conditional`)].join(", ")})`).join("; ")}`,
      ...uncertain
        .filter(
          (r) => r.measuredAdvantages.length > 0 || r.measuredCosts.length > 0
        )
        .map(
          (r) => `${r.kind} measured: ${describe(r).slice(r.kind.length + 2)}`
        )
    );
  } else {
    disposition = "preserve-current";
    reasons.push(
      alternatives.length === 0
        ? "no alternative"
        : `${alternatives.filter((r) => r.status === "dominated").length} dominated, ${alternatives.filter((r) => r.status === "equivalent").length} equivalent, ${alternatives.filter((r) => r.status === "preservation-conflict").length} in preservation conflict`
    );
  }
  return disposition;
}

function reviewPackageArchitectureFamilyI2(
  nondominatedMembers: Reviewed[],
  tradeoffs: ScenarioTradeoff[],
  tradeoffPairCounts: Map<string, number>
) {
  for (let i = 0; i < nondominatedMembers.length; i += 1) {
    reviewPackageArchitectureFamilyI2J(
      i,
      nondominatedMembers,
      tradeoffs,
      tradeoffPairCounts
    );
  }
}

function reviewPackageArchitectureFamilyI2J(
  i: number,
  nondominatedMembers: Reviewed[],
  tradeoffs: ScenarioTradeoff[],
  tradeoffPairCounts: Map<string, number>
) {
  for (let j = i + 1; j < nondominatedMembers.length; j += 1) {
    const a = nondominatedMembers[i];
    const b = nondominatedMembers[j];
    if (a === undefined || b === undefined) {
      continue;
    }
    const leftBetter: ReviewDimension[] = [];
    const rightBetter: ReviewDimension[] = [];
    reviewPackageArchitectureFamilyI2JDimension(
      a,
      b,
      tradeoffs,
      leftBetter,
      rightBetter
    );
    for (const x of leftBetter) {
      for (const y of rightBetter) {
        const key = [x, y].sort().join("↔");
        tradeoffPairCounts.set(key, (tradeoffPairCounts.get(key) ?? 0) + 1);
      }
    }
  }
}

function reviewPackageArchitectureFamilyI2JDimension(
  a: Reviewed,
  b: Reviewed,
  tradeoffs: ScenarioTradeoff[],
  leftBetter: ReviewDimension[],
  rightBetter: ReviewDimension[]
) {
  for (const dimension of DIMENSIONS) {
    if (DIMENSION_ROLES[dimension] === "blocking") {
      continue;
    }
    const left = effectOf(a.effects, dimension);
    const right = effectOf(b.effects, dimension);
    const comparison = compareDimension(left, right);
    if (comparison === "equal") {
      continue;
    }
    const certainty = weaker(left.certainty, right.certainty);
    const differing = (own: ReviewMeasure[], other: ReviewMeasure[]) =>
      own.filter(
        (m) =>
          m.comparison !== "none" &&
          m.delta !== (other.find((o) => o.name === m.name)?.delta ?? 0)
      );
    tradeoffs.push({
      certainty,
      comparison,
      dimension,
      evidence: {
        left: differing(left.measures, right.measures),
        right: differing(right.measures, left.measures),
      },
      left: a.scenario.id,
      right: b.scenario.id,
    });
    if (DIMENSION_ROLES[dimension] !== "comparison") {
      continue;
    }
    if (certainty !== "measured") {
      continue;
    }
    if (comparison === "better") {
      leftBetter.push(dimension);
    }
    if (comparison === "worse") {
      rightBetter.push(dimension);
    }
  }
}

function reviewPackageArchitectureFamilyI(
  members: Reviewed[],
  dominatedBy: Map<string, string[]>,
  pairCounts: {
    alternativeOverAlternative: number;
    alternativeOverBaseline: number;
    baselineOverAlternative: number;
    noDominance: number;
  },
  isBaseline: (m: Reviewed) => boolean,
  isAlternative: (m: Reviewed) => boolean
) {
  for (let i = 0; i < members.length; i += 1) {
    reviewPackageArchitectureFamilyIJ(
      i,
      members,
      dominatedBy,
      pairCounts,
      isBaseline,
      isAlternative
    );
  }
}

function reviewPackageArchitectureFamilyIJ(
  i: number,
  members: Reviewed[],
  dominatedBy: Map<string, string[]>,
  pairCounts: {
    alternativeOverAlternative: number;
    alternativeOverBaseline: number;
    baselineOverAlternative: number;
    noDominance: number;
  },
  isBaseline: (m: Reviewed) => boolean,
  isAlternative: (m: Reviewed) => boolean
) {
  for (let j = i + 1; j < members.length; j += 1) {
    const a = members[i];
    const b = members[j];
    if (a === undefined || b === undefined) {
      continue;
    }
    const ab = dominatedBy.get(b.scenario.id)?.includes(a.scenario.id);
    const ba = dominatedBy.get(a.scenario.id)?.includes(b.scenario.id);
    if (ab !== true && ba !== true) {
      pairCounts.noDominance += 1;
      continue;
    }
    const dominant = ab === true ? a : b;
    const loser = ab === true ? b : a;
    if (isBaseline(dominant) && isAlternative(loser)) {
      pairCounts.baselineOverAlternative += 1;
    } else if (isAlternative(dominant) && isBaseline(loser)) {
      pairCounts.alternativeOverBaseline += 1;
    } else {
      pairCounts.alternativeOverAlternative += 1;
    }
  }
}

function reviewPackageArchitectureEntries(
  isBaseline: (m: Reviewed) => boolean,
  m: Reviewed,
  missing: RewiringPreservation[],
  dominatedBy: Map<string, string[]>,
  unresolved: ReviewDimension[],
  advantages: ReviewDimension[],
  mixed: ReviewDimension[],
  conditionalDifference: boolean
): ScenarioReviewStatus {
  let status: ScenarioReviewStatus;
  if (isBaseline(m)) {
    status = "baseline";
  } else if (PRESERVATION_KINDS.includes(m.scenario.kind)) {
    status = "preservation";
  } else if (missing.length > 0) {
    status = "preservation-conflict";
  } else if ((dominatedBy.get(m.scenario.id) ?? []).length > 0) {
    status = "dominated";
  } else if (unresolved.length > 0) {
    status = "uncertain";
  } else if (advantages.length > 0 || mixed.length > 0) {
    status = "credible";
  } else if (conditionalDifference) {
    status = "uncertain";
  } else {
    status = "equivalent";
  }
  return status;
}

function collectDimension(
  m: Reviewed,
  baseline: Reviewed,
  advantages: ReviewDimension[],
  costs: ReviewDimension[],
  mixed: ReviewDimension[],
  initialConditionalDifference: boolean
) {
  let conditionalDifference = initialConditionalDifference;
  for (const dimension of COMPARISON_DIMENSIONS) {
    const left = effectOf(m.effects, dimension);
    const right = effectOf(baseline.effects, dimension);
    const comparison = compareDimension(left, right);
    const measured =
      left.certainty === "measured" && right.certainty === "measured";
    if (comparison === "better" && measured) {
      advantages.push(dimension);
    }
    if (comparison === "worse" && measured) {
      costs.push(dimension);
    }
    if (comparison === "mixed" && measured) {
      mixed.push(dimension);
    }
    if (comparison !== "equal" && !measured) {
      conditionalDifference = true;
    }
  }
  return conditionalDifference;
}

function buildSubjects(
  families: ScenarioFamilyReview[],
  scenarios: ReviewedRewiringScenario[],
  rewiring: InternalRewiringReport,
  policy: AnalysisConfig["internalReview"]
): SubjectArchitectureReview[] {
  const compositionByModule = new Map(
    rewiring.composition.map((c) => [c.module, c])
  );
  const scenarioById = new Map(rewiring.scenarios.map((s) => [s.id, s]));
  const reviewedByFamily = new Map<string, ReviewedRewiringScenario[]>();
  for (const reviewed of scenarios) {
    reviewedByFamily.set(reviewed.familyId, [
      ...(reviewedByFamily.get(reviewed.familyId) ?? []),
      reviewed,
    ]);
  }
  const bySubject = new Map<
    string,
    {
      kind: SubjectArchitectureReview["subject"]["kind"];
      families: ScenarioFamilyReview[];
    }
  >();
  for (const family of families) {
    const key =
      family.subject.kind === "responsibility-relationship"
        ? family.subject.key
        : (family.subject.module ?? family.subject.key);
    const kind =
      family.subject.kind === "responsibility-relationship"
        ? "responsibility-relationship"
        : "module";
    const entry = bySubject.get(key) ?? { families: [], kind };
    entry.families.push(family);
    bySubject.set(key, entry);
  }
  return [...bySubject.entries()]
    .map(([key, entry]): SubjectArchitectureReview => {
      const reviewed = entry.families.flatMap(
        (f) => reviewedByFamily.get(f.id) ?? []
      );
      const alternatives = reviewed.filter(
        (r) => r.status !== "baseline" && r.status !== "preservation"
      );
      const nondominated = alternatives.filter(
        (r) =>
          r.dominatedBy.length === 0 && r.status !== "preservation-conflict"
      );
      const dispositions: Partial<Record<FamilyReviewDisposition, number>> = {};
      for (const family of entry.families) {
        dispositions[family.disposition] =
          (dispositions[family.disposition] ?? 0) + 1;
      }
      const changing = new Set<ReviewDimension>();
      for (const r of alternatives) {
        for (const d of r.effects) {
          if (
            DIMENSION_ROLES[d.dimension] === "comparison" &&
            d.direction !== "unchanged"
          ) {
            changing.add(d.dimension);
          }
        }
      }
      const closures = alternatives
        .map((r) => r.closure)
        .filter((c): c is ClosureSize => c !== undefined)
        .sort((a, b) => CLOSURE_ORDER.indexOf(b) - CLOSURE_ORDER.indexOf(a));
      const composition = compositionByModule.get(key);
      const moduleScenario = entry.families
        .flatMap((f) => f.scenarios)
        .map((id) => scenarioById.get(id))
        .find((s) => s?.subject.kind === "module");
      const cycle = entry.families
        .flatMap((f) => f.scenarios)
        .map((id) => scenarioById.get(id)?.effects.cycles.membership[0])
        .find((c) => c !== undefined);
      const questions = sorted([
        ...alternatives.flatMap((r) => r.effects.flatMap((d) => d.conditions)),
        ...entry.families.flatMap((f) => f.missingEvidence),
      ]);
      const complexity = {
        alternatives: alternatives.length,
        families: entry.families.length,
        nondominatedAlternatives: nondominated.length,
        ...(closures[0] !== undefined && { largestClosure: closures[0] }),
        ...(moduleScenario?.current.scopeGroups !== undefined && {
          scopeGroups: moduleScenario.current.scopeGroups.length,
        }),
        changingDimensions: changing.size,
        uncertainAlternatives: alternatives.filter(
          (r) => r.status === "uncertain"
        ).length,
      };
      return {
        complex:
          complexity.nondominatedAlternatives >=
            policy.complexSubject.minimumNondominatedAlternatives &&
          complexity.changingDimensions >=
            policy.complexSubject.minimumChangingDimensions,
        complexity,
        currentEvidence: {
          ...(composition !== undefined && {
            status: composition.status,
            ...(composition.responsibility !== undefined && {
              responsibility: composition.responsibility,
            }),
            compositionRoles: composition.roles,
            compositionRoot: composition.compositionRoot,
            exportedSymbols: composition.exportedSymbols,
          }),
          ...(moduleScenario?.current.scopeGroups !== undefined && {
            scopeGroups: moduleScenario.current.scopeGroups.length,
          }),
          ...(cycle !== undefined && { cycle }),
        },
        dispositions,
        families: entry.families.map((f) => f.id),
        nondominatedScenarios: sorted(
          reviewed
            .filter((r) => r.dominatedBy.length === 0)
            .map((r) => r.scenarioId)
        ),
        subject: { key, kind: entry.kind },
        unresolvedQuestions: questions,
      };
    })
    .sort((a, b) => a.subject.key.localeCompare(b.subject.key));
}

function summarize(
  families: ScenarioFamilyReview[],
  scenarios: ReviewedRewiringScenario[],
  subjects: SubjectArchitectureReview[],
  dominance: PackageArchitectureReviewSummary["dominance"],
  tradeoffPairCounts: Map<string, number>,
  scenarioById: Map<string, InternalRewiringScenario>
): PackageArchitectureReviewSummary {
  const byDisposition = zeroRecord(DISPOSITIONS);
  const familySizes = zeroRecord(["1", "2", "3", "4+"] as const);
  const visitFamily = () => {
    for (const family of families) {
      byDisposition[family.disposition] += 1;
      if (family.scenarios.length === 0) {
        continue;
      }
      const size = family.scenarios.length;
      familySizes[resolveVisitFamily(size)] += 1;
    }
  };
  visitFamily();
  const byStatus = zeroRecord(STATUSES);
  const byKind: PackageArchitectureReviewSummary["byKind"] = Object.fromEntries(
    [...new Set(scenarios.map((s) => s.kind))].sort().map((k) => [k, {}])
  ) as PackageArchitectureReviewSummary["byKind"];
  const closureByStatus = Object.fromEntries(
    CLOSURE_ORDER.map((c) => [c, {}])
  ) as PackageArchitectureReviewSummary["closureByStatus"];
  const uncertaintyReasons: Partial<Record<ScenarioUncertaintyReason, number>> =
    {};
  const unresolvedDimensions: Partial<Record<ReviewDimension, number>> = {};
  const conventions = {
    competingTradeoffs: 0,
    supportedCredible: 0,
    supportedDominated: 0,
    supportedUncertain: 0,
  };
  let responsibilityDependent = 0;
  let rootsPreserved = 0;
  const low: ReviewedRewiringScenario[] = [];
  const high: ReviewedRewiringScenario[] = [];
  const visitReviewed = () => {
    ({ rootsPreserved, responsibilityDependent } = summarizeReviewed(
      scenarios,
      byStatus,
      byKind,
      closureByStatus,
      rootsPreserved,
      uncertaintyReasons,
      unresolvedDimensions,
      scenarioById,
      conventions,
      responsibilityDependent,
      low,
      high
    ));
  };
  visitReviewed();
  const insufficient = new Map<string, number>();
  for (const family of families) {
    if (family.disposition !== "insufficient-evidence") {
      continue;
    }
    for (const reason of family.missingEvidence) {
      insufficient.set(reason, (insufficient.get(reason) ?? 0) + 1);
    }
  }
  const preservationReasons: Partial<Record<RewiringPreservation, number>> = {};
  for (const family of families) {
    if (family.disposition !== "preservation-required") {
      continue;
    }
    for (const preservation of family.preservationRequirements) {
      preservationReasons[preservation] =
        (preservationReasons[preservation] ?? 0) + 1;
    }
  }
  const byUncertainty = (r: ReviewedRewiringScenario) =>
    r.uncertainty.unresolvedDimensions.length * 2 +
    r.uncertainty.conditionalDimensions.length;
  return {
    byKind,
    closureByStatus,
    complexSubjects: subjects
      .filter((s) => s.complex)
      .map((s) => s.subject.key),
    compositionRootsPreserved: rootsPreserved,
    conventions,
    dominance,
    families: { byDisposition, total: families.length },
    familySizes,
    highUncertaintyAlternatives: high
      .sort(
        (a, b) =>
          byUncertainty(b) - byUncertainty(a) ||
          a.scenarioId.localeCompare(b.scenarioId)
      )
      .map((r) => r.scenarioId),
    insufficientEvidenceReasons: [...insufficient.entries()]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([reason, count]) => ({ count, reason })),
    lowUncertaintyAlternatives: low
      .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId))
      .map((r) => r.scenarioId),
    preservationReasons,
    responsibilityDependentAlternatives: responsibilityDependent,
    scenarios: { byStatus, total: scenarios.length },
    tradeoffPairs: [...tradeoffPairCounts.entries()]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([key, count]) => {
        const [x, y] = key.split("↔") as [ReviewDimension, ReviewDimension];
        return { count, dimensions: [x, y] };
      }),
    uncertaintyReasons,
    unresolvedDimensions,
  };
}

function resolveVisitFamily(size: number): "4+" | "3" | "2" | "1" {
  if (size >= 4) {
    return "4+";
  }
  if (size === 3) {
    return "3";
  }
  if (size === 2) {
    return "2";
  }
  return "1";
}

function summarizeReviewed(
  scenarios: ReviewedRewiringScenario[],
  byStatus: Record<ScenarioReviewStatus, number>,
  byKind: Record<
    InternalRewiringScenarioKind,
    Partial<Record<ScenarioReviewStatus, number>>
  >,
  closureByStatus: Record<
    ClosureSize,
    Partial<Record<ScenarioReviewStatus, number>>
  >,
  initialRootsPreserved: number,
  uncertaintyReasons: Partial<Record<ScenarioUncertaintyReason, number>>,
  unresolvedDimensions: Partial<Record<ReviewDimension, number>>,
  scenarioById: Map<string, InternalRewiringScenario>,
  conventions: {
    competingTradeoffs: number;
    supportedCredible: number;
    supportedDominated: number;
    supportedUncertain: number;
  },
  initialResponsibilityDependent: number,
  low: ReviewedRewiringScenario[],
  high: ReviewedRewiringScenario[]
) {
  let responsibilityDependent = initialResponsibilityDependent;
  let rootsPreserved = initialRootsPreserved;
  const visitReviewed2 = (reviewed: ReviewedRewiringScenario) => {
    byStatus[reviewed.status] += 1;
    const kindEntry = byKind[reviewed.kind];
    kindEntry[reviewed.status] = (kindEntry[reviewed.status] ?? 0) + 1;
    if (reviewed.closure !== undefined) {
      const entry = closureByStatus[reviewed.closure];
      entry[reviewed.status] = (entry[reviewed.status] ?? 0) + 1;
    }
    if (reviewed.kind === "preserve-composition-root") {
      rootsPreserved += 1;
    }
    if (reviewed.status === "baseline" || reviewed.status === "preservation") {
      return;
    }
    const visitReason = (reason: ScenarioUncertaintyReason) => {
      uncertaintyReasons[reason] = (uncertaintyReasons[reason] ?? 0) + 1;
    };
    responsibilityDependent = collectVisitDimension2(
      reviewed,
      visitReason,
      unresolvedDimensions,
      scenarioById,
      conventions,
      responsibilityDependent,
      low,
      high
    );
  };
  for (const reviewed of scenarios) {
    visitReviewed2(reviewed);
  }
  return { responsibilityDependent, rootsPreserved };
}

function collectVisitDimension2(
  reviewed: ReviewedRewiringScenario,
  visitReason: (reason: ScenarioUncertaintyReason) => void,
  unresolvedDimensions: Partial<Record<ReviewDimension, number>>,
  scenarioById: Map<string, InternalRewiringScenario>,
  conventions: {
    competingTradeoffs: number;
    supportedCredible: number;
    supportedDominated: number;
    supportedUncertain: number;
  },
  initialResponsibilityDependent: number,
  low: ReviewedRewiringScenario[],
  high: ReviewedRewiringScenario[]
) {
  let responsibilityDependent = initialResponsibilityDependent;
  for (const reason of reviewed.uncertainty.reasons) {
    visitReason(reason);
  }
  const visitDimension2 = (dimension: ReviewDimension) => {
    unresolvedDimensions[dimension] =
      (unresolvedDimensions[dimension] ?? 0) + 1;
  };
  for (const dimension of reviewed.uncertainty.unresolvedDimensions) {
    visitDimension2(dimension);
  }
  const alignment = scenarioById.get(reviewed.scenarioId)?.effects.conventions
    .alignment;
  summarizeReviewedEntries(alignment, reviewed, conventions);
  if (alignment === "competing-convention" && reviewed.status === "credible") {
    conventions.competingTradeoffs += 1;
  }
  if (
    reviewed.measuredAdvantages.includes("locality") ||
    reviewed.measuredAdvantages.includes("responsibility-boundaries")
  ) {
    responsibilityDependent += 1;
  }
  summarizeReviewedEntries2(reviewed, low);
  if (
    reviewed.status === "uncertain" &&
    reviewed.uncertainty.unresolvedDimensions.length +
      reviewed.uncertainty.conditionalDimensions.length >=
      2
  ) {
    high.push(reviewed);
  }
  return responsibilityDependent;
}

function summarizeReviewedEntries2(
  reviewed: ReviewedRewiringScenario,
  low: ReviewedRewiringScenario[]
) {
  if (
    reviewed.status === "credible" &&
    reviewed.uncertainty.conditionalDimensions.length === 0 &&
    (reviewed.closure === undefined ||
      reviewed.closure === "independent" ||
      reviewed.closure === "small")
  ) {
    low.push(reviewed);
  }
}

function summarizeReviewedEntries(
  alignment: ConventionAlignment | undefined,
  reviewed: ReviewedRewiringScenario,
  conventions: {
    competingTradeoffs: number;
    supportedCredible: number;
    supportedDominated: number;
    supportedUncertain: number;
  }
) {
  if (alignment === "matches-convention") {
    if (reviewed.status === "credible") {
      conventions.supportedCredible += 1;
    } else if (reviewed.status === "dominated") {
      conventions.supportedDominated += 1;
    } else if (reviewed.status === "uncertain") {
      conventions.supportedUncertain += 1;
    }
  }
}

export function getReviewForScenario(
  review: PackageArchitectureReview,
  scenarioId: string
): ReviewedRewiringScenario | undefined {
  return review.scenarios.find((s) => s.scenarioId === scenarioId);
}

export function getReviewForFamily(
  review: PackageArchitectureReview,
  familyId: string
): ScenarioFamilyReview | undefined {
  return review.families.find((f) => f.id === familyId);
}

export function getReviewForSubject(
  review: PackageArchitectureReview,
  key: string
): SubjectArchitectureReview | undefined {
  return review.subjects.find((s) => s.subject.key === key);
}

export function getReviewsByDisposition(
  review: PackageArchitectureReview,
  disposition: FamilyReviewDisposition
): ScenarioFamilyReview[] {
  return review.families.filter((f) => f.disposition === disposition);
}

export function getNondominatedScenarios(
  review: PackageArchitectureReview,
  familyId?: string
): ReviewedRewiringScenario[] {
  return review.scenarios.filter(
    (s) =>
      s.dominatedBy.length === 0 &&
      (familyId === undefined || s.familyId === familyId)
  );
}
