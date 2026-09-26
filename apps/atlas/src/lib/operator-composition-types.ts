import type {
  OperatorDecompositionGap,
  StructuralAction,
  StructuralActionDependency,
  StructuralActionGroup,
  StructuralActionKind,
} from "./operator-decomposition-types";
import type {
  OperatorExpectedEffect,
  OperatorFact,
  OperatorPreservationKind,
  OperatorVerificationKind,
} from "./operator-types";

// V11.2 operator composition: several operators and their decompositions
// combined into one structural action graph. Equivalent actions become one
// action with provenance; dependencies merge and cross-operator ones are
// inferred from fixed rules; contradictions are surfaced, never resolved.
// Nothing here chooses intent or names a file.

/** Independent of the operator and decomposition schemas: compositions may persist on their own. */
export const COMPOSITION_SCHEMA_VERSION = 1;

/** Bumps when a merge, inference, or conflict rule changes; part of the fingerprint. */
export const COMPOSITION_RULES_VERSION = 1;

/** Operator-independent identity of a structural action; ids are operator-scoped, keys are not. */
export interface StructuralActionCanonicalKey {
  current?: string;
  kind: StructuralActionKind;
  subject: string;
  target?: string;
}

/** A merged action: the V11.1 shape plus where it came from. */
export interface ComposedStructuralAction extends StructuralAction {
  sourceActions: string[];
  sourceOperators: string[];
}

export interface SharedStructuralAction {
  canonicalActionId: string;
  mergedActionId: string;
  sourceActions: string[];
  sourceOperators: string[];
}

export type CompositionDependencyOrigin = "explicit" | "inferred";

export interface ComposedActionDependency extends StructuralActionDependency {
  origin: CompositionDependencyOrigin;
  /** The inference rule that produced an inferred edge. */
  rule?: string;
  sourceOperators: string[];
}

export type OperatorCompositionConflictKind =
  | "target-conflict"
  | "placement-conflict"
  | "preservation-conflict"
  | "exposure-conflict"
  | "dependency-conflict"
  | "anchor-conflict"
  | "action-effect-conflict"
  | "action-order-conflict"
  | "operator-intent-conflict";

export interface OperatorCompositionConflict {
  actions: string[];
  detail: string;
  /** Concepts, packages, boundaries, preservation ids: whatever the contradiction is about. */
  entities: string[];
  kind: OperatorCompositionConflictKind;
  operators: string[];
}

export type CompositionPreservationStatus =
  | "covered"
  | "implicit"
  | "conflicted"
  | "uncovered";

export interface CompositionPreservation {
  coverageActions: string[];
  entityIds: string[];
  kind: OperatorPreservationKind;
  /** `kind:entityIds`, as V11.1 names it. */
  preservationId: string;
  requiredByOperators: string[];
  status: CompositionPreservationStatus;
}

export type CompositionEffectRelation =
  | "compatible"
  | "duplicate"
  | "conflicting";

/** Operator effects on one dimension and change for one subject; never a new prediction. */
export interface CompositionEffect {
  change: string;
  changes: OperatorExpectedEffect[];
  dimension: string;
  relation: CompositionEffectRelation;
  sourceOperators: string[];
  subjects: string[];
}

export type CompositionVerificationStatus =
  | "compatible"
  | "conflicting"
  | "unresolved";

export interface CompositionVerification {
  expected: OperatorFact;
  kind: OperatorVerificationKind;
  relatedActions: string[];
  requiredByOperators: string[];
  status: CompositionVerificationStatus;
}

export type CompositionGapResolutionStatus =
  | "resolved"
  | "unresolved"
  | "conflicted";

export interface CompositionGapResolution {
  /** `<operator id>/<gap kind>:<entities>` */
  gapId: string;
  resolvedByActions: string[];
  resolvedByOperators: string[];
  sourceOperator: string;
  status: CompositionGapResolutionStatus;
}

/** A decomposition gap carried into the composition with its source. */
export interface OperatorCompositionGap extends OperatorDecompositionGap {
  id: string;
  sourceOperator: string;
}

export interface OperatorCompositionDiagnostics {
  conflicts: number;
  explicitDependencies: number;
  gapsRemaining: number;
  gapsResolved: number;
  inferredDependencies: number;
  inputActions: number;
  inputOperators: number;
  mergedActions: number;
  /** Decompositions built here because none was supplied or the supplied one was behind its operator. */
  redecomposed: string[];
  sharedActions: number;
}

export interface CompositionFingerprint {
  facts: string[];
  hash: string;
}

/**
 * Precedence: `stale` (an operator or decomposition no longer matches the
 * facts) > `unsupported` (an operator has no decomposition) > `conflicted`
 * (no combined intent exists) > `blocked` (coherent, but an operator is
 * blocked) > `partial` (a gap remains) > `complete`.
 */
export type OperatorCompositionStatus =
  | "complete"
  | "partial"
  | "blocked"
  | "conflicted"
  | "stale"
  | "unsupported";

export interface OperatorComposition {
  actions: ComposedStructuralAction[];
  conflicts: OperatorCompositionConflict[];
  dependencies: ComposedActionDependency[];
  diagnostics: OperatorCompositionDiagnostics;
  effects: CompositionEffect[];
  fingerprint: CompositionFingerprint;
  groups: StructuralActionGroup[];
  /** `composition:<hash>` over sorted operator ids, operator fingerprints, and the schema version. */
  id: string;
  /** Operators whose input was stale, unsupported, or blocked, with the reason. */
  inputProblems: string[];
  operators: string[];
  preservations: CompositionPreservation[];
  /** One entry per carried gap, resolved or not. */
  resolutions: CompositionGapResolution[];
  schemaVersion: typeof COMPOSITION_SCHEMA_VERSION;
  sharedActions: SharedStructuralAction[];
  status: OperatorCompositionStatus;
  /** Every carried gap whose resolution is not `resolved`. */
  unresolved: OperatorCompositionGap[];
  verification: CompositionVerification[];
}

export type OperatorCompositionValidationStatus = "valid" | "invalid" | "stale";

export interface OperatorCompositionValidation {
  compositionId: string;
  /** Fingerprint over the same inputs read now; absent when an input no longer resolves. */
  currentFingerprint?: string;
  cycles: string[][];
  fingerprint: string;
  problems: string[];
  status: OperatorCompositionValidationStatus;
}
