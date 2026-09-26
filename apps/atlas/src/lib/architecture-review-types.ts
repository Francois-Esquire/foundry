import type {
  ClosureSize,
  CompositionRoleKind,
  InternalRewiringScenarioKind,
  RewiringPreservation,
  ScenarioSubject,
  ScenarioUncertaintyReason,
} from "./internal-rewiring-types";

// V13.5 package architecture review: the V13.4 scenarios of one subject
// compared across separate architectural dimensions. Dominance is strict
// and Pareto-like over measured differences; unresolved dimensions block it
// both ways; preservation requirements block it one way. No dimension is
// weighted against another, no family gets a score, and a family with
// several nondominated arrangements is a finding, not a failure.

export const PACKAGE_ARCHITECTURE_REVIEW_SCHEMA_VERSION = 1;

export type ReviewDimension =
  | "locality"
  | "responsibility-boundaries"
  | "dependency-topology"
  | "module-composition"
  | "surface-indirection"
  | "cycles"
  | "convention-alignment"
  | "movement-closure"
  | "preservation"
  | "uncertainty";

/**
 * `comparison`: bears on dominance. `supporting`: reported and compared,
 * never decides dominance. `blocking`: can only prevent dominance.
 */
export type ReviewDimensionRole = "comparison" | "supporting" | "blocking";

/** Raw direction of a scenario's change on a dimension; not a quality. */
export type EffectDirection =
  | "reduced"
  | "increased"
  | "unchanged"
  | "mixed"
  | "unknown";

/**
 * `measured`: simulated from canonical topology with no open assumption.
 * `conditional`: simulated under a stated assumption. `unresolved`: the
 * effect cannot be classified until missing evidence is resolvable.
 */
export type EffectCertainty = "measured" | "conditional" | "unresolved";

/** Which direction of a measure reads as no worse when two scenarios are compared; `none` is evidence only. */
export type MeasureComparison = "lower" | "higher" | "none";

export interface ReviewMeasure {
  after: number;
  before: number;
  comparison: MeasureComparison;
  delta: number;
  name: string;
}

export interface ReviewedEffectDimension {
  certainty: EffectCertainty;
  /** Why the certainty is not `measured`. */
  conditions: string[];
  dimension: ReviewDimension;
  direction: EffectDirection;
  measures: ReviewMeasure[];
}

/** One scenario against another on one dimension. */
export type DimensionComparison =
  | "better"
  | "worse"
  | "equal"
  | "mixed"
  | "incomparable";

export interface ScenarioPreservationStatus {
  kept: RewiringPreservation[];
  missing: RewiringPreservation[];
  /** Architectural preservations asserted by a preservation scenario of the family. */
  required: RewiringPreservation[];
}

export interface ScenarioUncertaintyStatus {
  conditionalDimensions: ReviewDimension[];
  reasons: ScenarioUncertaintyReason[];
  /** Recorded limitations that do not change any comparison. */
  standing: ScenarioUncertaintyReason[];
  unresolvedDimensions: ReviewDimension[];
}

export type ScenarioReviewStatus =
  | "baseline"
  | "preservation"
  | "credible"
  | "uncertain"
  | "equivalent"
  | "dominated"
  | "preservation-conflict";

export interface ReviewedRewiringScenario {
  closure?: ClosureSize;
  dominatedBy: string[];
  dominates: string[];
  /** Empty for the baseline and the preservation scenarios: unchanged and measured everywhere. */
  effects: ReviewedEffectDimension[];
  /** V13.4 scenario id; provenance to earlier stages lives on the scenario. */
  evidence: { scenario: string };
  familyId: string;
  kind: InternalRewiringScenarioKind;
  /** Dimensions where the scenario is measured strictly better than the family baseline. */
  measuredAdvantages: ReviewDimension[];
  /** Dimensions where the scenario is measured strictly worse than the family baseline. */
  measuredCosts: ReviewDimension[];
  /** Dimensions where measures move both ways against the baseline: a tradeoff inside one dimension. */
  measuredTradeoffs: ReviewDimension[];
  preservation: ScenarioPreservationStatus;
  scenarioId: string;
  status: ScenarioReviewStatus;
  uncertainty: ScenarioUncertaintyStatus;
}

export type FamilyReviewDisposition =
  | "preserve-current"
  | "credible-alternative"
  | "multiple-tradeoffs"
  | "preservation-required"
  | "uncertainty-blocked"
  | "insufficient-evidence";

export interface ScenarioTradeoff {
  certainty: EffectCertainty;
  /** From the left scenario's side. */
  comparison: DimensionComparison;
  dimension: ReviewDimension;
  /** The compared measures whose deltas differ between the two scenarios. */
  evidence: { left: ReviewMeasure[]; right: ReviewMeasure[] };
  left: string;
  right: string;
}

export interface DominanceRelation {
  dominant: string;
  dominated: string;
  /** Dimensions where the dominant scenario is measured strictly better. */
  improves: ReviewDimension[];
}

export interface ScenarioFamilyReview {
  /** `preserve-current` where present; otherwise the family's preservation scenario. */
  baseline?: string;
  baselineKind?: InternalRewiringScenarioKind;
  disposition: FamilyReviewDisposition;
  dominance: DominanceRelation[];
  dominated: string[];
  /** The V13.4 subject key. */
  id: string;
  /** Missing evidence of the candidates, for an insufficient-evidence family. */
  missingEvidence: string[];
  nondominated: string[];
  preservationRequirements: RewiringPreservation[];
  /** Facts the disposition follows from. */
  reasons: string[];
  scenarios: string[];
  subject: ScenarioSubject;
  tradeoffs: ScenarioTradeoff[];
}

export interface SubjectComplexity {
  alternatives: number;
  /** Distinct comparison dimensions any alternative changes. */
  changingDimensions: number;
  families: number;
  largestClosure?: ClosureSize;
  nondominatedAlternatives: number;
  scopeGroups?: number;
  uncertainAlternatives: number;
}

export interface SubjectArchitectureReview {
  /** Meets the policy's complex-subject criteria; a review workload, not a problem. */
  complex: boolean;
  complexity: SubjectComplexity;
  currentEvidence: {
    status?: string;
    responsibility?: string;
    compositionRoles?: CompositionRoleKind[];
    compositionRoot?: boolean;
    exportedSymbols?: number;
    scopeGroups?: number;
    cycle?: string;
  };
  dispositions: Partial<Record<FamilyReviewDisposition, number>>;
  families: string[];
  nondominatedScenarios: string[];
  subject: { kind: "module" | "responsibility-relationship"; key: string };
  unresolvedQuestions: string[];
}

export interface PackageArchitectureReviewSummary {
  byKind: Record<
    InternalRewiringScenarioKind,
    Partial<Record<ScenarioReviewStatus, number>>
  >;
  closureByStatus: Record<
    ClosureSize,
    Partial<Record<ScenarioReviewStatus, number>>
  >;
  complexSubjects: string[];
  compositionRootsPreserved: number;
  conventions: {
    supportedCredible: number;
    supportedDominated: number;
    supportedUncertain: number;
    competingTradeoffs: number;
  };
  dominance: {
    baselineOverAlternative: number;
    alternativeOverBaseline: number;
    alternativeOverAlternative: number;
    /** Scenario pairs within a family with no dominance either way. */
    noDominance: number;
  };
  families: {
    total: number;
    byDisposition: Record<FamilyReviewDisposition, number>;
  };
  familySizes: Record<"1" | "2" | "3" | "4+", number>;
  highUncertaintyAlternatives: string[];
  insufficientEvidenceReasons: { reason: string; count: number }[];
  lowUncertaintyAlternatives: string[];
  /** Families whose disposition is preservation-required, by required preservation. */
  preservationReasons: Partial<Record<RewiringPreservation, number>>;
  /** Alternatives whose measured advantages are boundary or locality effects that only responsibility regions can express. */
  responsibilityDependentAlternatives: number;
  scenarios: { total: number; byStatus: Record<ScenarioReviewStatus, number> };
  /** Dimension pairs pulling nondominated scenarios apart, most frequent first. */
  tradeoffPairs: {
    dimensions: [ReviewDimension, ReviewDimension];
    count: number;
  }[];
  uncertaintyReasons: Partial<Record<ScenarioUncertaintyReason, number>>;
  unresolvedDimensions: Partial<Record<ReviewDimension, number>>;
}

export interface PackageArchitectureReviewPolicy {
  /** Preservations a preservation scenario can require of every alternative. */
  architecturalPreservations: RewiringPreservation[];
  certainty: Record<EffectCertainty, string>;
  comparisonScope: "within scenario family";
  complexSubject: {
    minimumNondominatedAlternatives: number;
    minimumChangingDimensions: number;
  };
  dimensionDefinitions: Record<ReviewDimension, string>;
  dimensionRoles: Record<ReviewDimension, ReviewDimensionRole>;
  dimensions: ReviewDimension[];
  dispositionDefinitions: Record<FamilyReviewDisposition, string>;
  dispositionPrecedence: string;
  dispositions: FamilyReviewDisposition[];
  dominance: string;
  ranking: "none";
  score: "none";
  severity: "none";
  standingLimitations: ScenarioUncertaintyReason[];
  statusDefinitions: Record<ScenarioReviewStatus, string>;
  statuses: ScenarioReviewStatus[];
  /** Which uncertainty reasons change which dimension's certainty; the rest are standing limitations. */
  uncertaintyEffects: Partial<
    Record<
      ScenarioUncertaintyReason,
      { dimension: ReviewDimension; certainty: EffectCertainty }
    >
  >;
}

export interface PackageArchitectureReview {
  /** By family id. */
  families: ScenarioFamilyReview[];
  limitations: string[];
  package: { id: string; root: string };
  policy: PackageArchitectureReviewPolicy;
  /** By family id, then family order. */
  scenarios: ReviewedRewiringScenario[];
  schemaVersion: typeof PACKAGE_ARCHITECTURE_REVIEW_SCHEMA_VERSION;
  /** By subject key. */
  subjects: SubjectArchitectureReview[];
  summary: PackageArchitectureReviewSummary;
}
