import type {
  PlannedTransformationKind,
  PlannedVerificationKind,
} from "./operator-plan-types";
import type {
  ArchitecturalOperatorKind,
  OperatorFact,
  OperatorPreservationKind,
} from "./operator-types";

// V11.4 readiness: the last read-only gate before a mutator touches the
// repository. It judges the plan we have against the repository as it is
// now and answers with one explicit authorization; it never repairs the
// plan, never chooses transformations, and never writes.

/** Readiness records persist and are consumed by V12; independent of the plan schema. */
export const OPERATOR_READINESS_SCHEMA_VERSION = 1;

/** Bumps when a gate rule changes: coverage requirements, baseline handling, cautions vs blockers. */
export const OPERATOR_READINESS_POLICY_VERSION = 1;

/**
 * Precedence: `stale` (a planned file's bytes changed) > `unsupported` (a
 * transformation or its syntax form has no mutator) > `blocked` (a positive
 * contradiction: conflict, violated preservation, cycle, failed baseline,
 * impossible rollback) > `not-authorized` (something required is missing:
 * an unrealized action, a conditional transformation, an unproven
 * preservation, a verification step that cannot run) > `authorized`.
 */
export type MutationAuthorization =
  | "authorized"
  | "not-authorized"
  | "stale"
  | "blocked"
  | "unsupported";

export type ReadinessFileStatus =
  | "unchanged"
  | "changed"
  | "missing"
  | "unexpected";

export interface ReadinessFileState {
  actual: string;
  /** Hash the plan fingerprinted; `absent` for files the plan creates. */
  expected: string;
  file: string;
  status: ReadinessFileStatus;
}

export interface ReadinessGitState {
  available: boolean;
  /** Planned files with uncommitted changes whose bytes still match the plan. */
  plannedDirty: string[];
  /** Dirty files the plan does not touch; context, never a gate. */
  unplannedDirty: number;
}

export interface ReadinessSourceState {
  expectedFiles: ReadinessFileState[];
  expectedManifests: ReadinessFileState[];
  git: ReadinessGitState;
  missingFiles: string[];
  staleFiles: string[];
  unchanged: boolean;
  /** Files the plan creates that already exist. */
  unexpectedFiles: string[];
}

export interface ReadinessCompleteness {
  complete: boolean;
  /**
   * Transformations the plan marks conditional, each resolved now: `required`
   * when fresh planning against the unchanged sources still yields it (the
   * condition holds), `unresolved` otherwise. Nothing conditional reaches V12.
   */
  conditionalTransformations: ReadinessConditionalResolution[];
  coveredEffects: number;
  coveredPreservations: number;
  expectedEffects: number;
  plannedVerificationRequirements: number;
  preservations: number;
  realizedActions: number;
  requiredActions: number;
  unresolvedGaps: string[];
  verificationRequirements: number;
}

export interface ReadinessConditionalResolution {
  detail: string;
  resolution: "required" | "unresolved";
  transformationId: string;
}

export interface ReadinessConsistency {
  consistent: boolean;
  /** The plan re-plans to the same record against the current sources. */
  matchesFreshPlanning: boolean;
  noActionCoverageConflict: boolean;
  noDestinationConflicts: boolean;
  noDuplicateConflicts: boolean;
  noExportConflicts: boolean;
  noImportConflicts: boolean;
  noManifestConflicts: boolean;
  transformationDagAcyclic: boolean;
}

export type ReadinessConstraintKind =
  | "anchor"
  | "representation-boundary"
  | "implementation-split"
  | "public-surface"
  | "consumer-compatibility"
  | "type-value-dependency"
  | "package-dependency"
  | "package-cycle"
  | "module-cycle"
  | "side-effects"
  | "coverage"
  | "structural-conformance";

export type ReadinessConstraintResult = "pass" | "fail" | "not-applicable";

export interface ReadinessConstraintCheck {
  detail: string;
  entities: string[];
  kind: ReadinessConstraintKind;
  status: ReadinessConstraintResult;
}

export interface ReadinessConstraintStatus {
  checks: ReadinessConstraintCheck[];
  compatible: boolean;
}

export interface ReadinessUnsupportedForm {
  form?: string;
  kind: PlannedTransformationKind;
  reason: string;
  transformationId: string;
}

export interface ReadinessMutationCapability {
  atomic: boolean;
  form: string;
  occurrences: number;
  reversible: boolean;
  supported: boolean;
  transformationKind: PlannedTransformationKind;
}

export interface ReadinessClosureState {
  actionId: string;
  complete: boolean;
  sharedInternalSymbols: string[];
}

export interface ReadinessRealizability {
  closures: ReadinessClosureState[];
  mutationCapabilities: ReadinessMutationCapability[];
  realizable: boolean;
  /** Modules with top-level execution that a move would relocate. */
  sideEffectModules: string[];
  supportedSyntaxForms: string[];
  supportedTransformations: number;
  unsupportedSyntaxForms: ReadinessUnsupportedForm[];
  unsupportedTransformations: number;
}

export type ReadinessPreservationResult =
  | "transformed"
  | "proven"
  | "unproven"
  | "violated";

export interface ReadinessPreservationState {
  detail: string;
  kind: OperatorPreservationKind;
  preservationId: string;
  status: ReadinessPreservationResult;
  transformations: string[];
  verification: string[];
}

export interface ReadinessPreservationStatus {
  covered: boolean;
  preservations: ReadinessPreservationState[];
}

export interface ReadinessCommand {
  args: string[];
  /** Root-relative. */
  cwd: string;
  executable: string;
  expectedExitCode: number;
}

export type ReadinessVerificationMode = "command" | "analyzer" | "unresolvable";

export interface ReadinessVerificationStep {
  command?: ReadinessCommand;
  dependsOn: string[];
  /** Why the step cannot run. */
  detail?: string;
  expected: OperatorFact;
  id: string;
  kind: PlannedVerificationKind;
  mode: ReadinessVerificationMode;
  /** Analyzer query V12 runs after mutation; `<check>:<scope>`. */
  query?: string;
  scope: string[];
}

export interface VerificationBaselineAllowance {
  allowed: boolean;
  /** Verification step id or kind the allowance applies to. */
  check: string;
  /** Failure identities (diagnostic keys, failing test ids) known before this plan. */
  knownFailures: string[];
  /** Where the allowance comes from: a ticket, a stream, a baseline record. */
  provenance: string;
}

export type ReadinessBaselineStatus =
  | "pass"
  | "allowed-failure"
  | "fail"
  | "skipped";

export interface ReadinessCommandResult {
  exitCode: number;
  /** Failure identities the check extracted, sorted. */
  failures: string[];
}

export interface ReadinessBaselineCheck {
  /** Allowance that turned a failure into `allowed-failure`. */
  allowance?: string;
  detail: string;
  id: string;
  kind: PlannedVerificationKind;
  result?: ReadinessCommandResult;
  status: ReadinessBaselineStatus;
}

export interface ReadinessArchitecturalAssertion {
  before: OperatorFact;
  dimension: string;
  expectedAfter: OperatorFact;
  source: { operatorEffectIds: string[]; planTransformationIds: string[] };
  verificationQuery: string;
}

export interface ReadinessVerificationStatus {
  allowances: VerificationBaselineAllowance[];
  assertions: ReadinessArchitecturalAssertion[];
  baselineChecks: ReadinessBaselineCheck[];
  complete: boolean;
  executable: boolean;
  steps: ReadinessVerificationStep[];
}

export type RollbackAction = "restore" | "delete" | "recreate";

export interface RollbackFile {
  /** What rollback does: restore edited bytes, delete a created file, recreate a deleted one. */
  action: RollbackAction;
  detail?: string;
  file: string;
  /** Hash of the bytes to restore; `absent` for created files. */
  hash: string;
  restorable: boolean;
}

export interface ReadinessRollbackContract {
  complete: boolean;
  createdFiles: string[];
  deletedFiles: string[];
  files: RollbackFile[];
  manifests: RollbackFile[];
  strategy: "byte-snapshot" | "unsupported";
}

export type ReadinessRiskKind =
  | "breaking-public-surface"
  | "runtime-dependency-change"
  | "module-cycle-change"
  | "package-cycle-change"
  | "side-effect-module"
  | "broad-consumer-impact"
  | "test-coverage-limited"
  | "partial-workspace-coverage"
  | "structural-conformance-gap";

export interface ReadinessRisk {
  /** The risk also produced a blocker. */
  blocking: boolean;
  detail: string;
  entities: string[];
  kind: ReadinessRiskKind;
}

export type ReadinessBlockerKind =
  | "source-stale"
  | "plan-incomplete"
  | "transformation-conflict"
  | "unsupported-transformation"
  | "unsupported-syntax"
  | "anchor-violation"
  | "preservation-violation"
  | "public-surface-unresolved"
  | "dependency-cycle"
  | "dependency-unexpected"
  | "side-effect-module"
  | "coverage-insufficient"
  | "structural-conformance-unknown"
  | "baseline-verification-failed"
  | "rollback-incomplete"
  | "verification-incomplete";

export interface ReadinessBlocker {
  detail: string;
  entities: string[];
  kind: ReadinessBlockerKind;
}

export type ReadinessCautionKind =
  | "planned-file-dirty"
  | "unplanned-files-dirty"
  | "allowed-baseline-failure"
  | "coverage-partial"
  | "structural-conformance-unobserved"
  | "broad-consumer-impact"
  | "environment-unverified";

export interface ReadinessCaution {
  detail: string;
  entities: string[];
  kind: ReadinessCautionKind;
}

export type MutationCoverageScope =
  | "subject-only"
  | "source-target"
  | "source-target-consumers"
  | "all-participating"
  | "workspace";

export interface MutationCoverageRequirement {
  kind: ArchitecturalOperatorKind;
  requiredPackages: MutationCoverageScope;
}

export interface ReadinessIntentCoverage {
  effectsCovered: boolean;
  operatorId: string;
  preconditionsCovered: boolean;
  preservationsCovered: boolean;
  verificationCovered: boolean;
}

export interface MutationAuthorizationFingerprint {
  capabilityFingerprint: string;
  /** `auth:<hash>` over the five above. */
  hash: string;
  planFingerprint: string;
  rollbackFingerprint: string;
  sourceFingerprint: string;
  verificationFingerprint: string;
}

/** Wall-clock measurements; outside every fingerprint and never compared. */
export interface ReadinessTimings {
  baselineMs: number;
  sourceMs: number;
  structuralMs: number;
}

export interface OperatorPlanReadiness {
  authorization: MutationAuthorization;
  blockers: ReadinessBlocker[];
  capabilityVersion: number;
  cautions: ReadinessCaution[];
  completeness: ReadinessCompleteness;
  consistency: ReadinessConsistency;
  constraints: ReadinessConstraintStatus;
  /** What V12 must and must not do with this record. */
  contract: string[];
  fingerprint: MutationAuthorizationFingerprint;
  intents: ReadinessIntentCoverage[];
  planFingerprint: string;
  planId: string;
  policyVersion: typeof OPERATOR_READINESS_POLICY_VERSION;
  preservation: ReadinessPreservationStatus;
  realizability: ReadinessRealizability;
  risks: ReadinessRisk[];
  rollback: ReadinessRollbackContract;
  schemaVersion: typeof OPERATOR_READINESS_SCHEMA_VERSION;
  sourceState: ReadinessSourceState;
  timings: ReadinessTimings;
  verification: ReadinessVerificationStatus;
}

/** Plan and readiness by id; the records themselves persist separately. */
export interface AuthorizedMutationPlan {
  authorization: MutationAuthorization;
  authorizationFingerprint: MutationAuthorizationFingerprint;
  planId: string;
  readinessFingerprint: string;
  schemaVersion: typeof OPERATOR_READINESS_SCHEMA_VERSION;
}
