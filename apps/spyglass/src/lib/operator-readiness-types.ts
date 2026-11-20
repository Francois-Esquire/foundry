import type {
  PlannedTransformationKind,
  PlannedVerificationKind,
} from "./operator-plan-types";
import type {
  ArchitecturalOperatorKind,
  OperatorFact,
  OperatorPreservationKind,
} from "./operator-types";

export const OPERATOR_READINESS_SCHEMA_VERSION = 1;

export const OPERATOR_READINESS_POLICY_VERSION = 1;

export type MutationAuthorization =
  | "authorized"
  | "not-authorized"
  | "stale"
  | "blocked"
  | "unsupported";

type ReadinessFileStatus = "unchanged" | "changed" | "missing" | "unexpected";

export interface ReadinessFileState {
  actual: string;
  expected: string;
  file: string;
  status: ReadinessFileStatus;
}

interface ReadinessGitState {
  available: boolean;
  plannedDirty: string[];
  unplannedDirty: number;
}

export interface ReadinessSourceState {
  expectedFiles: ReadinessFileState[];
  expectedManifests: ReadinessFileState[];
  git: ReadinessGitState;
  missingFiles: string[];
  staleFiles: string[];
  unchanged: boolean;
  unexpectedFiles: string[];
}

export interface ReadinessCompleteness {
  complete: boolean;
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

interface ReadinessClosureState {
  actionId: string;
  complete: boolean;
  sharedInternalSymbols: string[];
}

export interface ReadinessRealizability {
  closures: ReadinessClosureState[];
  mutationCapabilities: ReadinessMutationCapability[];
  realizable: boolean;
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
  cwd: string;
  executable: string;
  expectedExitCode: number;
}

type ReadinessVerificationMode = "command" | "analyzer" | "unresolvable";

export interface ReadinessVerificationStep {
  command?: ReadinessCommand;
  dependsOn: string[];
  detail?: string;
  expected: OperatorFact;
  id: string;
  kind: PlannedVerificationKind;
  mode: ReadinessVerificationMode;
  query?: string;
  scope: string[];
}

export interface VerificationBaselineAllowance {
  allowed: boolean;
  check: string;
  knownFailures: string[];
  provenance: string;
}

type ReadinessBaselineStatus = "pass" | "allowed-failure" | "fail" | "skipped";

export interface ReadinessCommandResult {
  exitCode: number;
  failures: string[];
}

export interface ReadinessBaselineCheck {
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

type RollbackAction = "restore" | "delete" | "recreate";

export interface RollbackFile {
  action: RollbackAction;
  detail?: string;
  file: string;
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

type ReadinessCautionKind =
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
  hash: string;
  planFingerprint: string;
  rollbackFingerprint: string;
  sourceFingerprint: string;
  verificationFingerprint: string;
}

interface ReadinessTimings {
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

export const AUTHORIZED_MUTATION_PLAN_SCHEMA_VERSION = 2;

export interface AuthorizedMutationFingerprint
  extends Omit<MutationAuthorizationFingerprint, "hash"> {
  hash: string;
  ruleFingerprint: string;
}

interface AuthorizedSourceFile {
  file: string;
  hash: string;
}

export interface MutationExecution {
  mutator: "internalize-export";
  planFingerprint: string;
  planId: string;
}

export interface AuthorizedMutationPlan {
  authorization: "authorized";
  authorizationFingerprint: AuthorizedMutationFingerprint;
  execution: MutationExecution;
  executionPlanId: string;
  permittedBy: number[];
  readinessFingerprint: string;
  schemaVersion: typeof AUTHORIZED_MUTATION_PLAN_SCHEMA_VERSION;
  sourceFiles: AuthorizedSourceFile[];
}
