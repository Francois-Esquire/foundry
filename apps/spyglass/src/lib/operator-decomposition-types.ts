import type {
  ArchitecturalOperatorKind,
  OperatorEvidenceRef,
  OperatorExpectedEffect,
  OperatorLocation,
  OperatorPreconditionKind,
} from "./operator-types";

// V11.1 operator decomposition: one architectural operator expanded into a
// dependency graph of structural actions. An action names what must change
// or stay at the responsibility, exposure, dependency, and boundary level;
// it never names a file, a line, or an edit. Realization is V11.3.

/** Independent of the operator schema: decompositions may persist on their own. */
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

/** A concept's behavior in one role; never "the behavior of package B". */
interface BehaviorActionSubject {
  conceptId: string;
  kind: "behavior";
  role: "governing" | "implementation" | "conversion";
}

/** Concept-scoped unless the operator itself targets the whole boundary. */
interface BoundaryActionSubject {
  boundaryId: string;
  conceptId?: string;
  kind: "boundary";
}

/** What a package exposes of a concept or symbol; the seam later export planning refines. */
interface ExposureActionSubject {
  conceptId?: string;
  kind: "exposure";
  package: string;
  symbolId?: string;
}

/** One consumer's dependency on a provider, for one concept when known. */
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

/** A reference to an operator precondition the action relies on; never a new fact. */
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
  /** The operator's own effects this action accounts for; never a new prediction. */
  expectedEffects: OperatorExpectedEffect[];
  /** `<operator id>/<kind>:<subject>[:<current>→<target>]`; stable across runs and input order. */
  id: string;
  intent: StructuralActionIntent;
  kind: StructuralActionKind;
  preconditions: StructuralActionPrecondition[];
  /** Preservation ids (`kind:entityIds`) this action carries out. */
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

/**
 * `blocking` means the action set itself may be incomplete, so realization
 * planning must not treat it as the whole story. A non-blocking gap only
 * defers a refinement (which module, which surface strategy).
 */
export interface OperatorDecompositionGap {
  blocking: boolean;
  detail: string;
  entities: string[];
  kind: OperatorDecompositionGapKind;
}

type CoverageStatus = "covered" | "implicit" | "uncovered";

export interface PreservationCoverage {
  coveredByActions: string[];
  /** `kind:entityIds` of the operator preservation. */
  preservationId: string;
  status: CoverageStatus;
}

export interface VerificationCoverage {
  relatedActions: string[];
  /** The operator verification kind; one requirement per kind. */
  requirementId: string;
  status: "covered" | "unresolved";
}

export interface ExpectedEffectCoverage {
  actions: string[];
  /** `dimension:change:from→to` of the operator effect, with an ordinal on collision. */
  operatorEffectId: string;
  status: "covered" | "unresolved";
}

interface DecompositionFingerprint {
  facts: string[];
  hash: string;
}

/**
 * `complete`: every action is known and located at package level with no
 * gap. `partial`: actions are known but a gap remains. `blocked`: the
 * operator is blocked; actions show what it would require. `stale`: the
 * operator no longer matches the facts; no actions are derived. `unsupported`:
 * the operator kind has no decomposition rules.
 */
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

/** Data only: which subjects an action kind takes and whether it needs a target. */
export interface StructuralActionDefinition {
  /** Always false in V11.1: actions describe, nothing runs them. */
  executable: false;
  group: StructuralActionGroupKind;
  kind: StructuralActionKind;
  requiresTarget: boolean;
  supportedSubjects: StructuralActionSubjectKind[];
}

type OperatorDecompositionValidationStatus = "valid" | "invalid" | "stale";

export interface OperatorDecompositionValidation {
  /** Fingerprint over the same facts read now; absent when a fact no longer resolves. */
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
