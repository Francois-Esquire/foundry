import type {
  ArchitecturalReviewDisposition,
  ArchitecturalScenarioReview,
  InternalizeSymbolPlan,
  RecenteringScenario,
  RecenteringScenarioKind,
  ReviewedScenario,
  ScenarioImpactAnalysis,
  SurfaceReport,
} from "./types";
import type { WorkspaceProjectionContext } from "./workspace-projection-types";

export const OPERATOR_SCHEMA_VERSION = 1;

export type ArchitecturalOperatorKind =
  | "internalize"
  | "move"
  | "rehome-concept"
  | "rehome-behavior"
  | "redirect-dependency"
  | "preserve-boundary";

interface SymbolOperatorSubject {
  kind: "symbol";
  name: string;
  package: string;
  symbolId: string;
}

interface ConceptOperatorSubject {
  conceptId: string;
  kind: "concept";
}

interface PackageOperatorSubject {
  kind: "package";
  packageId: string;
}

interface BoundaryOperatorSubject {
  boundaryId: string;
  from: string;
  kind: "boundary";
  to: string;
}

interface BehaviorOperatorSubject {
  conceptId: string;
  kind: "behavior";
  packages: string[];
}

export type OperatorSubject =
  | SymbolOperatorSubject
  | ConceptOperatorSubject
  | PackageOperatorSubject
  | BoundaryOperatorSubject
  | BehaviorOperatorSubject;

type OperatorSubjectKind = OperatorSubject["kind"];

type OperatorIntentSource = "manual" | "architectural-review" | "existing-plan";

export interface OperatorIntent {
  planId?: string;
  reason: string;
  reviewId?: string;
  scenarioId?: string;
  source: OperatorIntentSource;
}

export interface OperatorLocation {
  module?: string;
  package?: string;
}

export interface OperatorPlacement {
  current?: OperatorLocation;
  target?: OperatorLocation;
}

type OperatorEvidenceSource =
  | "surface"
  | "workspace"
  | "concept"
  | "review"
  | "scenario"
  | "impact"
  | "anchor";

export interface OperatorEvidenceRef {
  entityIds: string[];
  source: OperatorEvidenceSource;
}

export type OperatorFact = string | number | boolean | string[] | null;

export type OperatorPreconditionKind =
  | "concept-exists"
  | "current-package"
  | "package-exists"
  | "boundary-exists"
  | "anchor-state"
  | "public-surface-state"
  | "external-usage-state"
  | "behavior-center-state"
  | "implementation-state"
  | "distinct-placement";

export interface OperatorPrecondition {
  entityIds: string[];
  evidenceRefs: OperatorEvidenceRef[];
  expected: OperatorFact;
  kind: OperatorPreconditionKind;
}

export type OperatorPreservationKind =
  | "public-contract"
  | "semantic-center"
  | "representation-boundary"
  | "implementation-split"
  | "anchor"
  | "consumer-import-path"
  | "runtime-behavior";

export interface OperatorPreservation {
  entityIds: string[];
  kind: OperatorPreservationKind;
  reason?: string;
}

export type OperatorEffectDimension =
  | "surface"
  | "behavior"
  | "boundary"
  | "dependency"
  | "locality"
  | "ownership"
  | "representation";

export interface OperatorExpectedEffect {
  certainty: "certain" | "conditional";
  change: string;
  dimension: OperatorEffectDimension;
  evidenceRefs: OperatorEvidenceRef[];
  from?: OperatorFact;
  to?: OperatorFact;
}

export type OperatorVerificationKind =
  | "typecheck"
  | "tests"
  | "public-surface"
  | "concept-center"
  | "behavior-location"
  | "dependency-edge"
  | "boundary-interaction"
  | "anchor-preserved";

export interface OperatorVerificationRequirement {
  expected: OperatorFact;
  kind: OperatorVerificationKind;
}

type OperatorConstraintKind =
  | "anchor"
  | "public-contract"
  | "representation-boundary"
  | "structural-conformance-unknown"
  | "coverage-incomplete";

type OperatorConstraintEffect = "informational" | "constraining" | "blocking";

export interface OperatorConstraint {
  detail: string;
  effect: OperatorConstraintEffect;
  entityIds: string[];
  kind: OperatorConstraintKind;
}

export interface OperatorFingerprint {
  facts: string[];
  hash: string;
}

export type ArchitecturalOperatorStatus =
  | "draft"
  | "valid"
  | "blocked"
  | "unsupported";

export interface ArchitecturalOperator {
  constraints: OperatorConstraint[];
  evidence: OperatorEvidenceRef[];
  expectedEffects: OperatorExpectedEffect[];
  fingerprint: OperatorFingerprint;
  id: string;
  intent: OperatorIntent;
  kind: ArchitecturalOperatorKind;
  placement: OperatorPlacement;
  preconditions: OperatorPrecondition[];
  preservations: OperatorPreservation[];
  schemaVersion: typeof OPERATOR_SCHEMA_VERSION;
  status: ArchitecturalOperatorStatus;
  subject: OperatorSubject;
  verification: OperatorVerificationRequirement[];
}

export interface OperatorDefinition {
  decomposition: "supported" | "partial" | "unsupported";
  executable: boolean;
  kind: ArchitecturalOperatorKind;
  legacyOperatorId?: "internalize-export";
  requiredFields: string[];
  summary: string;
  supportedSubjects: OperatorSubjectKind[];
  verificationKinds: OperatorVerificationKind[];
}

export interface ScenarioOperatorMapping {
  gap?: string;
  operatorKind: ArchitecturalOperatorKind | null;
  scenarioKind: RecenteringScenarioKind;
}

type OperatorValidationStatus = "valid" | "blocked" | "stale" | "unsupported";

export interface OperatorPreconditionResult extends OperatorPrecondition {
  actual: OperatorFact;
  holds: boolean;
}

interface OperatorConstraintResult extends OperatorConstraint {
  decisive: boolean;
}

export interface OperatorValidation {
  cautions: string[];
  constraints: OperatorConstraintResult[];
  currentFingerprint?: string;
  fingerprint: string;
  operatorId: string;
  preconditions: OperatorPreconditionResult[];
  status: OperatorValidationStatus;
}

export interface OperatorScenarioSource {
  disposition?: ArchitecturalReviewDisposition;
  impact?: ScenarioImpactAnalysis;
  package: string;
  review?: ArchitecturalScenarioReview;
  reviewed?: ReviewedScenario;
  scenario: RecenteringScenario;
}

export interface OperatorContext {
  legacyPlansById: Map<
    string,
    { package: string; plan: InternalizeSymbolPlan }
  >;
  projection: WorkspaceProjectionContext;
  reportsByPackage: Map<string, SurfaceReport>;
  scenarios: Map<string, OperatorScenarioSource>;
}

export type OperatorFromScenarioResult =
  | { status: "created"; operator: ArchitecturalOperator }
  | {
      status: "unsupported";
      scenarioId: string;
      scenarioKind?: RecenteringScenarioKind;
      reason: string;
    };
