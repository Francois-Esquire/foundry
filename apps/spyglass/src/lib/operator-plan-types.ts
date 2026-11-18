import type { InternalizeEdits } from "./internalize-edits";
import type { OperatorEvidenceRef, OperatorFact } from "./operator-types";

export const OPERATOR_PLAN_SCHEMA_VERSION = 3;

export const OPERATOR_PLANNING_POLICY_VERSION = 1;

export type PlannedTransformationKind =
  | "move-symbol"
  | "move-module"
  | "create-module"
  | "remove-export"
  | "add-export"
  | "rewrite-import"
  | "rewrite-reexport"
  | "update-package-export"
  | "update-package-dependency"
  | "preserve-compatibility-export"
  | "delete-empty-module"
  | "update-test-import"
  | "verify-only";

export type PlannedImportKind = "named" | "type" | "default" | "namespace";

type PlannedExportForm =
  | "named-export"
  | "named-reexport"
  | "type-reexport"
  | "star-export"
  | "subpath-export";

export interface PlannedSourceState {
  dependency?: { package: string; declared: boolean };
  exportForm?: PlannedExportForm;
  importKind?: PlannedImportKind;
  module?: string;
  names?: string[];
  package?: string;
  runtime?: boolean;
  specifier?: string;
}

interface PlannedTransformationSubject {
  conceptId?: string;
  moduleId?: string;
  packageId?: string;
  symbolId?: string;
}

interface PlannedTransformationPrecondition {
  entityIds: string[];
  kind: string;
}

type PlannedTransformationStatus = "required" | "conditional" | "unsupported";

export interface PlannedTransformation {
  actions: string[];
  after?: PlannedSourceState;
  before?: PlannedSourceState;
  detail: string;
  evidence: OperatorEvidenceRef[];
  file: string;
  form?: string;
  id: string;
  kind: PlannedTransformationKind;
  preconditions: PlannedTransformationPrecondition[];
  preserves: string[];
  status: PlannedTransformationStatus;
  subject?: PlannedTransformationSubject;
}

export type PlannedTransformationDependencyKind =
  | "requires"
  | "preserve-before-remove"
  | "action-order";

export interface PlannedTransformationDependency {
  after: string;
  before: string;
  kind: PlannedTransformationDependencyKind;
  reason: string;
}

export type PlannedMovementGranularity =
  | "symbol"
  | "module"
  | "new-module"
  | "unresolved";

type PlannedSurfaceStrategy =
  | "direct-relocation"
  | "compatibility-reexport"
  | "target-public-old-internal"
  | "breaking-relocation"
  | "unresolved";

export type PlannedDependencyClass =
  | "move-with"
  | "import-from-source-package"
  | "import-from-target-package"
  | "import-from-third-package"
  | "external";

export interface PlannedClosureDependency {
  class: PlannedDependencyClass;
  id: string;
  name: string;
  package?: string;
  typeOnly: boolean;
}

export interface PlannedMovementClosure {
  complete: boolean;
  externalDependencies: PlannedClosureDependency[];
  requiredInternalSymbols: string[];
  rootSymbols: string[];
  sharedInternalSymbols: string[];
}

export type PlannedBehaviorMemberRole =
  | "governing"
  | "implementation"
  | "conversion"
  | "factory";

export interface PlannedBehaviorMember {
  role: PlannedBehaviorMemberRole;
  source: "concept-declaration" | "behavior-participant" | "representation";
  symbolId: string;
}

export interface PlannedRelocation {
  actionId: string;
  closure?: PlannedMovementClosure;
  conceptId?: string;
  granularity: PlannedMovementGranularity;
  members: PlannedBehaviorMember[];
  sourceModule?: string;
  sourcePackage: string;
  strategy: PlannedSurfaceStrategy;
  targetModule?: string;
  targetPackage: string;
  targetResolution?: string;
}

export interface PlannedImportRewrite {
  file: string;
  fromPackage: string;
  importedSymbolId: string;
  importKind: PlannedImportKind;
  moduleSpecifier: string;
  status: "supported" | "unsupported";
  toPackage: string;
  transformationId: string;
}

type StructuralActionRealizationStatus = "realized" | "partial" | "blocked";

export interface StructuralActionRealization {
  actionId: string;
  detail?: string;
  status: StructuralActionRealizationStatus;
  transformations: string[];
}

type PlannedPreservationStatus = "transformed" | "proven" | "unproven";

export interface PlannedPreservation {
  preservationId: string;
  status: PlannedPreservationStatus;
  transformations: string[];
  verification: string[];
}

export type PlannedDeltaDimension =
  | "surface"
  | "dependency"
  | "boundary"
  | "behavior"
  | "module"
  | "package";

export interface PlannedArchitecturalDelta {
  certainty: "certain" | "conditional";
  change: string;
  dimension: PlannedDeltaDimension;
  predicted: OperatorFact;
  sourceTransformations: string[];
  subjects: string[];
}

export type PlannedVerificationKind =
  | "typecheck"
  | "tests"
  | "analyze-package"
  | "analyze-workspace"
  | "verify-symbol-location"
  | "verify-public-surface"
  | "verify-imports"
  | "verify-dependency"
  | "verify-anchor";

export interface PlannedVerificationStep {
  dependsOn: string[];
  expected: OperatorFact;
  id: string;
  kind: PlannedVerificationKind;
  scope: string[];
  transformations: string[];
}

export type OperatorPlanBlockerKind =
  | "ambiguous-symbol"
  | "unsupported-export-form"
  | "unsupported-import-form"
  | "target-module-unresolved"
  | "module-mixed-responsibility"
  | "package-export-strategy-unresolved"
  | "dependency-cycle-risk"
  | "anchor-violation"
  | "structural-conformance-unknown"
  | "coverage-incomplete"
  | "source-state-mismatch"
  | "unsupported-realization"
  | "target-module-collision"
  | "composition-conflict";

export interface OperatorPlanBlocker {
  actions: string[];
  detail: string;
  entities: string[];
  kind: OperatorPlanBlockerKind;
}

type OperatorPlanConflictKind =
  | "same-symbol-multiple-destinations"
  | "import-rewrite-conflict"
  | "export-strategy-conflict"
  | "file-move-conflict"
  | "package-dependency-conflict"
  | "target-module-collision";

export interface OperatorPlanConflict {
  actions: string[];
  detail: string;
  entities: string[];
  kind: OperatorPlanConflictKind;
  transformations: string[];
}

export type OperatorPlanGapKind =
  | "target-module-unresolved"
  | "behavior-members-unresolved"
  | "surface-strategy-unresolved"
  | "dependency-target-unresolved"
  | "action-unrealized"
  | "closure-incomplete";

export interface OperatorPlanGap {
  actions: string[];
  detail: string;
  entities: string[];
  kind: OperatorPlanGapKind;
}

interface OperatorPlanInput {
  operatorId: string;
  package?: string;
}

type OperatorPlanTargetKind = "source" | "test" | "manifest";

export interface OperatorPlanTarget {
  file: string;
  kind: OperatorPlanTargetKind;
  package?: string;
  transformations: string[];
}

export interface OperatorPlanFileHash {
  file: string;
  hash: string;
}

export interface OperatorPlanFingerprint {
  factsHash: string;
  files: OperatorPlanFileHash[];
  hash: string;
  operatorCompositionFingerprint: string;
}

export interface OperatorPlanDiagnostics {
  exportChanges: number;
  files: number;
  importRewrites: number;
  kinds: PlannedTransformationKind[];
  manifestChanges: number;
  manifests: number;
  sourceFiles: number;
  sourceForms: { form: string; count: number }[];
  testFiles: number;
  transformations: number;
  unsupportedForms: string[];
}

export type OperatorExecutionPlanStatus =
  | "ready"
  | "partial"
  | "blocked"
  | "stale"
  | "unsupported";

export interface OperatorExecutionPlan {
  blockers: OperatorPlanBlocker[];
  compositionId: string;
  conflicts: OperatorPlanConflict[];
  dependencies: PlannedTransformationDependency[];
  diagnostics: OperatorPlanDiagnostics;
  fingerprint: OperatorPlanFingerprint;
  id: string;
  importRewrites: PlannedImportRewrite[];
  inputs: OperatorPlanInput[];
  mutation?: InternalizeEdits;
  policyVersion: typeof OPERATOR_PLANNING_POLICY_VERSION;
  predicted: PlannedArchitecturalDelta[];
  preserved: PlannedPreservation[];
  realizations: StructuralActionRealization[];
  relocations: PlannedRelocation[];
  schemaVersion: typeof OPERATOR_PLAN_SCHEMA_VERSION;
  status: OperatorExecutionPlanStatus;
  targets: OperatorPlanTarget[];
  transformations: PlannedTransformation[];
  unresolved: OperatorPlanGap[];
  verification: PlannedVerificationStep[];
}

type OperatorExecutionPlanValidationStatus = "valid" | "invalid" | "stale";

export interface OperatorExecutionPlanValidation {
  changedFiles: string[];
  currentFingerprint?: string;
  cycles: string[][];
  fingerprint: string;
  planId: string;
  problems: string[];
  status: OperatorExecutionPlanValidationStatus;
}
