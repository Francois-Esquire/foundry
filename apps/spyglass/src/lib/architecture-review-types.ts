import type {
  ClosureSize,
  CompositionRoleKind,
  InternalRewiringScenarioKind,
  RewiringPreservation,
  ScenarioSubject,
  ScenarioUncertaintyReason,
} from "./internal-rewiring-types";

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

export type ReviewDimensionRole = "comparison" | "supporting" | "blocking";

export type EffectDirection =
  | "reduced"
  | "increased"
  | "unchanged"
  | "mixed"
  | "unknown";

export type EffectCertainty = "measured" | "conditional" | "unresolved";

type MeasureComparison = "lower" | "higher" | "none";

export interface ReviewMeasure {
  after: number;
  before: number;
  comparison: MeasureComparison;
  delta: number;
  name: string;
}

export interface ReviewedEffectDimension {
  certainty: EffectCertainty;
  conditions: string[];
  dimension: ReviewDimension;
  direction: EffectDirection;
  measures: ReviewMeasure[];
}

export type DimensionComparison =
  | "better"
  | "worse"
  | "equal"
  | "mixed"
  | "incomparable";

interface ScenarioPreservationStatus {
  kept: RewiringPreservation[];
  missing: RewiringPreservation[];
  required: RewiringPreservation[];
}

interface ScenarioUncertaintyStatus {
  conditionalDimensions: ReviewDimension[];
  reasons: ScenarioUncertaintyReason[];
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
  effects: ReviewedEffectDimension[];
  evidence: { scenario: string };
  familyId: string;
  kind: InternalRewiringScenarioKind;
  measuredAdvantages: ReviewDimension[];
  measuredCosts: ReviewDimension[];
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
  comparison: DimensionComparison;
  dimension: ReviewDimension;
  evidence: { left: ReviewMeasure[]; right: ReviewMeasure[] };
  left: string;
  right: string;
}

export interface DominanceRelation {
  dominant: string;
  dominated: string;
  improves: ReviewDimension[];
}

export interface ScenarioFamilyReview {
  baseline?: string;
  baselineKind?: InternalRewiringScenarioKind;
  disposition: FamilyReviewDisposition;
  dominance: DominanceRelation[];
  dominated: string[];
  id: string;
  missingEvidence: string[];
  nondominated: string[];
  preservationRequirements: RewiringPreservation[];
  reasons: string[];
  scenarios: string[];
  subject: ScenarioSubject;
  tradeoffs: ScenarioTradeoff[];
}

interface SubjectComplexity {
  alternatives: number;
  changingDimensions: number;
  families: number;
  largestClosure?: ClosureSize;
  nondominatedAlternatives: number;
  scopeGroups?: number;
  uncertainAlternatives: number;
}

export interface SubjectArchitectureReview {
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
  preservationReasons: Partial<Record<RewiringPreservation, number>>;
  responsibilityDependentAlternatives: number;
  scenarios: { total: number; byStatus: Record<ScenarioReviewStatus, number> };
  tradeoffPairs: {
    dimensions: [ReviewDimension, ReviewDimension];
    count: number;
  }[];
  uncertaintyReasons: Partial<Record<ScenarioUncertaintyReason, number>>;
  unresolvedDimensions: Partial<Record<ReviewDimension, number>>;
}

interface PackageArchitectureReviewPolicy {
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
  uncertaintyEffects: Partial<
    Record<
      ScenarioUncertaintyReason,
      { dimension: ReviewDimension; certainty: EffectCertainty }
    >
  >;
}

export interface PackageArchitectureReview {
  families: ScenarioFamilyReview[];
  limitations: string[];
  package: { id: string; root: string };
  policy: PackageArchitectureReviewPolicy;
  scenarios: ReviewedRewiringScenario[];
  schemaVersion: typeof PACKAGE_ARCHITECTURE_REVIEW_SCHEMA_VERSION;
  subjects: SubjectArchitectureReview[];
  summary: PackageArchitectureReviewSummary;
}
