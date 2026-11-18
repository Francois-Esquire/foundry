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

export const COMPOSITION_SCHEMA_VERSION = 1;

export const COMPOSITION_RULES_VERSION = 1;

export interface StructuralActionCanonicalKey {
  current?: string;
  kind: StructuralActionKind;
  subject: string;
  target?: string;
}

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

type CompositionDependencyOrigin = "explicit" | "inferred";

export interface ComposedActionDependency extends StructuralActionDependency {
  origin: CompositionDependencyOrigin;
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
  entities: string[];
  kind: OperatorCompositionConflictKind;
  operators: string[];
}

type CompositionPreservationStatus =
  | "covered"
  | "implicit"
  | "conflicted"
  | "uncovered";

export interface CompositionPreservation {
  coverageActions: string[];
  entityIds: string[];
  kind: OperatorPreservationKind;
  preservationId: string;
  requiredByOperators: string[];
  status: CompositionPreservationStatus;
}

type CompositionEffectRelation = "compatible" | "duplicate" | "conflicting";

export interface CompositionEffect {
  change: string;
  changes: OperatorExpectedEffect[];
  dimension: string;
  relation: CompositionEffectRelation;
  sourceOperators: string[];
  subjects: string[];
}

type CompositionVerificationStatus =
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

type CompositionGapResolutionStatus = "resolved" | "unresolved" | "conflicted";

export interface CompositionGapResolution {
  gapId: string;
  resolvedByActions: string[];
  resolvedByOperators: string[];
  sourceOperator: string;
  status: CompositionGapResolutionStatus;
}

export interface OperatorCompositionGap extends OperatorDecompositionGap {
  id: string;
  sourceOperator: string;
}

interface OperatorCompositionDiagnostics {
  conflicts: number;
  explicitDependencies: number;
  gapsRemaining: number;
  gapsResolved: number;
  inferredDependencies: number;
  inputActions: number;
  inputOperators: number;
  mergedActions: number;
  redecomposed: string[];
  sharedActions: number;
}

interface CompositionFingerprint {
  facts: string[];
  hash: string;
}

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
  id: string;
  inputProblems: string[];
  operators: string[];
  preservations: CompositionPreservation[];
  resolutions: CompositionGapResolution[];
  schemaVersion: typeof COMPOSITION_SCHEMA_VERSION;
  sharedActions: SharedStructuralAction[];
  status: OperatorCompositionStatus;
  unresolved: OperatorCompositionGap[];
  verification: CompositionVerification[];
}

type OperatorCompositionValidationStatus = "valid" | "invalid" | "stale";

export interface OperatorCompositionValidation {
  compositionId: string;
  currentFingerprint?: string;
  cycles: string[][];
  fingerprint: string;
  problems: string[];
  status: OperatorCompositionValidationStatus;
}
