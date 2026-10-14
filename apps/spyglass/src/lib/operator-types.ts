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

// V11.0 architectural operators: a selected architectural intention as an
// immutable, evidence-backed contract. An operator says what responsibility
// should change, what must stay, what must hold first, and what must later
// be proven. It never says how source files change; that is V12.

/** Independent of the package and workspace schemas: operators may persist on their own. */
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
  /** `${from}→${to}` */
  boundaryId: string;
  from: string;
  kind: "boundary";
  to: string;
}

/** A concept's behavior as it sits in specific packages. */
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

/** The free-form reason never carries authority; the structured operator does. */
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

/** Package level is sufficient for architectural operators; module refinement is later planning. */
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

/** A pointer into canonical analysis; never a copy of it. */
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

/** What the operator is intentionally not supposed to change. */
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

/** Architecture-level before → after; never an edit prediction. */
export interface OperatorExpectedEffect {
  certainty: "certain" | "conditional";
  /** V8.3 change kind when inherited from an impact, else the builder's own vocabulary. */
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

/** What a later execution must prove; nothing runs here. */
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

/** Relevant facts only, never the repository; a mismatch later means the operator is stale. */
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
  /** `operator:<kind>:<subject id>[:<current>→<target>]`; stable across runs and input order. */
  id: string;
  intent: OperatorIntent;
  kind: ArchitecturalOperatorKind;
  placement: OperatorPlacement;
  preconditions: OperatorPrecondition[];
  preservations: OperatorPreservation[];
  schemaVersion: typeof OPERATOR_SCHEMA_VERSION;
  /** Validation outcome against the facts the operator was built from; `draft` when built without facts. */
  status: ArchitecturalOperatorStatus;
  subject: OperatorSubject;
  verification: OperatorVerificationRequirement[];
}

export interface OperatorDefinition {
  /** V11.1: `partial` when every decomposition of this kind leaves a realization gap. */
  decomposition: "supported" | "partial" | "unsupported";
  /** Only the legacy internalize path can run today, through `legacyOperatorId`. */
  executable: boolean;
  kind: ArchitecturalOperatorKind;
  legacyOperatorId?: "internalize-export";
  requiredFields: string[];
  summary: string;
  supportedSubjects: OperatorSubjectKind[];
  verificationKinds: OperatorVerificationKind[];
}

/** V8.2 scenario kind → V11.0 operator kind, or the exact gap. */
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
  /** The constraint decided the status. */
  decisive: boolean;
}

export interface OperatorValidation {
  cautions: string[];
  constraints: OperatorConstraintResult[];
  /** Fingerprint over the same facts read from the current context; absent when a fact no longer resolves. */
  currentFingerprint?: string;
  fingerprint: string;
  operatorId: string;
  preconditions: OperatorPreconditionResult[];
  status: OperatorValidationStatus;
}

/** Full V8 records for one scenario, from the declaring package's report. */
export interface OperatorScenarioSource {
  disposition?: ArchitecturalReviewDisposition;
  impact?: ScenarioImpactAnalysis;
  package: string;
  review?: ArchitecturalScenarioReview;
  reviewed?: ReviewedScenario;
  scenario: RecenteringScenario;
}

/**
 * Canonical workspace facts plus the package-level V8 records the workspace
 * only digests (placements, impact vectors) and the legacy internalize
 * plans. Reports are optional: manual operators need only the workspace.
 */
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
