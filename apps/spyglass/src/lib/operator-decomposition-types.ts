import type {
  ArchitecturalOperatorKind,
  OperatorEvidenceRef,
  OperatorExpectedEffect,
  OperatorLocation,
  OperatorPreconditionKind,
} from "./operator-types";

export const DECOMPOSITION_SCHEMA_VERSION = 1;

export type StructuralActionKind =
  | "relocate-semantic-declaration"
  | "relocate-behavior-responsibility"
  | "redirect-concept-dependency"
  | "establish-target-exposure"
  | "preserve-public-exposure"
  | "internalize-old-exposure"
  | "preserve-representation-boundary"
  | "preserve-implementation-split"
  | "remove-boundary-participation"
  | "preserve-anchor-boundary";

export type StructuralActionGroupKind =
  | "placement"
  | "surface"
  | "dependency"
  | "preservation"
  | "verification";

interface ConceptActionSubject {
  conceptId: string;
  kind: "concept";
}

interface SymbolActionSubject {
  kind: "symbol";
  package: string;
  symbolId: string;
}

interface BehaviorActionSubject {
  conceptId: string;
  kind: "behavior";
  role: "governing" | "implementation" | "conversion";
}

interface BoundaryActionSubject {
  boundaryId: string;
  conceptId?: string;
  kind: "boundary";
}

interface ExposureActionSubject {
  conceptId?: string;
  kind: "exposure";
  package: string;
  symbolId?: string;
}

interface DependencyActionSubject {
  conceptId?: string;
  consumer: string;
  kind: "dependency";
  provider: string;
}

interface PackageActionSubject {
  kind: "package";
  packageId: string;
}

export type StructuralActionSubject =
  | ConceptActionSubject
  | SymbolActionSubject
  | BehaviorActionSubject
  | BoundaryActionSubject
  | ExposureActionSubject
  | DependencyActionSubject
  | PackageActionSubject;

type StructuralActionSubjectKind = StructuralActionSubject["kind"];

export type StructuralLocation = OperatorLocation;

interface StructuralActionIntent {
  group: StructuralActionGroupKind;
  summary: string;
}

export interface StructuralActionPrecondition {
  entityIds: string[];
  kind: OperatorPreconditionKind;
}

export type StructuralActionStatus =
  | "required"
  | "conditional"
  | "blocked"
  | "unsupported";

export interface StructuralAction {
  current?: StructuralLocation;
  evidence: OperatorEvidenceRef[];
  expectedEffects: OperatorExpectedEffect[];
  id: string;
  intent: StructuralActionIntent;
  kind: StructuralActionKind;
  preconditions: StructuralActionPrecondition[];
  preserves: string[];
  status: StructuralActionStatus;
  subject: StructuralActionSubject;
  target?: StructuralLocation;
}

export type StructuralActionDependencyKind =
  | "requires"
  | "preserve-before-remove"
  | "verification-order";

export interface StructuralActionDependency {
  after: string;
  before: string;
  kind: StructuralActionDependencyKind;
  reason: string;
}

export interface StructuralActionGroup {
  actionIds: string[];
  kind: StructuralActionGroupKind;
}

export type OperatorDecompositionGapKind =
  | "target-module-unresolved"
  | "surface-transition-unspecified"
  | "structural-conformance-unknown"
  | "behavior-members-unresolved"
  | "dependency-target-unresolved"
  | "representation-strategy-unspecified"
  | "unsupported-action-kind";

export interface OperatorDecompositionGap {
  blocking: boolean;
  detail: string;
  entities: string[];
  kind: OperatorDecompositionGapKind;
}

type CoverageStatus = "covered" | "implicit" | "uncovered";

export interface PreservationCoverage {
  coveredByActions: string[];
  preservationId: string;
  status: CoverageStatus;
}

export interface VerificationCoverage {
  relatedActions: string[];
  requirementId: string;
  status: "covered" | "unresolved";
}

export interface ExpectedEffectCoverage {
  actions: string[];
  operatorEffectId: string;
  status: "covered" | "unresolved";
}

interface DecompositionFingerprint {
  facts: string[];
  hash: string;
}

export type OperatorDecompositionStatus =
  | "complete"
  | "partial"
  | "blocked"
  | "stale"
  | "unsupported";

export interface OperatorDecomposition {
  actions: StructuralAction[];
  dependencies: StructuralActionDependency[];
  effectCoverage: ExpectedEffectCoverage[];
  fingerprint: DecompositionFingerprint;
  groups: StructuralActionGroup[];
  operatorFingerprint: string;
  operatorId: string;
  operatorKind: ArchitecturalOperatorKind;
  preservationCoverage: PreservationCoverage[];
  schemaVersion: typeof DECOMPOSITION_SCHEMA_VERSION;
  status: OperatorDecompositionStatus;
  unresolved: OperatorDecompositionGap[];
  verificationCoverage: VerificationCoverage[];
}

export interface StructuralActionDefinition {
  executable: false;
  group: StructuralActionGroupKind;
  kind: StructuralActionKind;
  requiresTarget: boolean;
  supportedSubjects: StructuralActionSubjectKind[];
}

type OperatorDecompositionValidationStatus = "valid" | "invalid" | "stale";

export interface OperatorDecompositionValidation {
  currentFingerprint?: string;
  cycles: string[][];
  effectCoverage: ExpectedEffectCoverage[];
  fingerprint: string;
  operatorId: string;
  preservationCoverage: PreservationCoverage[];
  problems: string[];
  status: OperatorDecompositionValidationStatus;
  verificationCoverage: VerificationCoverage[];
}
