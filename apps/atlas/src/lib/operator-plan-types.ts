import type { OperatorEvidenceRef, OperatorFact } from "./operator-types";

// V11.3 source-aware operator planning: a composed structural action graph
// resolved against the actual TypeScript sources into exact, dependency-
// ordered transformations naming files, symbols, imports, exports, and
// manifests. A plan describes edits; nothing here performs one.

/** Independent of the operator, decomposition, and composition schemas: plans may persist on their own. 2: transformations carry `form`. */
export const OPERATOR_PLAN_SCHEMA_VERSION = 2;

/** Bumps when a resolution rule (target module, new module, surface strategy) changes; part of the plan id. */
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

export type PlannedExportForm =
  | "named-export"
  | "named-reexport"
  | "type-reexport"
  | "star-export"
  | "subpath-export";

/**
 * One side of a transformation, in source terms. Which fields apply depends
 * on the kind: an import rewrite carries specifiers, an export change carries
 * the form, a manifest change carries the dependency.
 */
export interface PlannedSourceState {
  /** Manifest dependency, for `update-package-dependency`. */
  dependency?: { package: string; declared: boolean };
  exportForm?: PlannedExportForm;
  importKind?: PlannedImportKind;
  /** Root-relative file. */
  module?: string;
  /** Names bound at this site, sorted. */
  names?: string[];
  package?: string;
  /** The dependency carries runtime code, not only types. */
  runtime?: boolean;
  /** Import or re-export module specifier as written in source. */
  specifier?: string;
}

export interface PlannedTransformationSubject {
  conceptId?: string;
  moduleId?: string;
  packageId?: string;
  symbolId?: string;
}

/** A reference to an operator precondition the transformation relies on; never a new fact. */
export interface PlannedTransformationPrecondition {
  entityIds: string[];
  kind: string;
}

export type PlannedTransformationStatus =
  | "required"
  | "conditional"
  | "unsupported";

export interface PlannedTransformation {
  /** Structural actions realized here; several when actions share one source edit. */
  actions: string[];
  after?: PlannedSourceState;
  before?: PlannedSourceState;
  /** What the change is, in one sentence of source terms. */
  detail: string;
  evidence: OperatorEvidenceRef[];
  /** Root-relative file the transformation touches. */
  file: string;
  /** Syntax form behind the change (`named-import`, `type-reexport`, `symbol-move`, ...); the vocabulary `diagnostics.sourceForms` counts. */
  form?: string;
  /** `transformation:<hash>` over kind, file, subject, before, and after; never the plan id. */
  id: string;
  kind: PlannedTransformationKind;
  preconditions: PlannedTransformationPrecondition[];
  /** Preservation ids (`kind:entityIds`) this transformation carries out. */
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

export type PlannedSurfaceStrategy =
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

/** One declaration a moved symbol needs, and where it comes from after the move. */
export interface PlannedClosureDependency {
  class: PlannedDependencyClass;
  /** Symbol id (`<file>#<Name>`) for workspace declarations; the module specifier for external ones. */
  id: string;
  name: string;
  package?: string;
  /** The reference is type-only, so no runtime dependency follows it. */
  typeOnly: boolean;
}

export interface PlannedMovementClosure {
  /** Every internal requirement can move without duplication. */
  complete: boolean;
  externalDependencies: PlannedClosureDependency[];
  /** Non-exported same-module declarations the roots need; they move too. */
  requiredInternalSymbols: string[];
  rootSymbols: string[];
  /** Same-module declarations the roots need that remaining code also needs. */
  sharedInternalSymbols: string[];
}

export type PlannedBehaviorMemberRole =
  | "governing"
  | "implementation"
  | "conversion"
  | "factory";

/** One symbol the relocation moves and how the plan knows it belongs. */
export interface PlannedBehaviorMember {
  role: PlannedBehaviorMemberRole;
  /** V7 evidence kind that classified the member. */
  source: "concept-declaration" | "behavior-participant" | "representation";
  symbolId: string;
}

/** How one relocation action resolves against the sources. */
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
  /** Which resolution rule picked the target module. */
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

export type StructuralActionRealizationStatus =
  | "realized"
  | "partial"
  | "blocked";

export interface StructuralActionRealization {
  actionId: string;
  /** Why the realization is not complete. */
  detail?: string;
  status: StructuralActionRealizationStatus;
  transformations: string[];
}

export type PlannedPreservationStatus = "transformed" | "proven" | "unproven";

export interface PlannedPreservation {
  preservationId: string;
  status: PlannedPreservationStatus;
  /** Transformations that carry the preservation out. */
  transformations: string[];
  /** Verification steps that prove it holds after the plan. */
  verification: string[];
}

export type PlannedDeltaDimension =
  | "surface"
  | "dependency"
  | "boundary"
  | "behavior"
  | "module"
  | "package";

/** An operator effect mapped onto the transformations that realize it; never a new prediction. */
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
  /** `verify:<kind>:<scope>` */
  id: string;
  kind: PlannedVerificationKind;
  /** Packages, files, or symbols the check reads. */
  scope: string[];
  /** Transformations the step proves. */
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
  /** Actions the blocker stops. */
  actions: string[];
  detail: string;
  /** Files, symbols, packages: whatever the blocker is about. */
  entities: string[];
  kind: OperatorPlanBlockerKind;
}

export type OperatorPlanConflictKind =
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

export interface OperatorPlanInput {
  operatorId: string;
  /** Package this operator's subject sits in. */
  package?: string;
}

export type OperatorPlanTargetKind = "source" | "test" | "manifest";

export interface OperatorPlanTarget {
  /** Root-relative file. */
  file: string;
  kind: OperatorPlanTargetKind;
  package?: string;
  transformations: string[];
}

export interface OperatorPlanFileHash {
  file: string;
  /** sha256 of the file bytes; `missing` when the file does not exist. */
  hash: string;
}

export interface OperatorPlanFingerprint {
  /** Over the operator facts the composition fingerprint already carries. */
  factsHash: string;
  /** Planned files, manifests, and entrypoints read; nothing else in the repository. */
  files: OperatorPlanFileHash[];
  hash: string;
  operatorCompositionFingerprint: string;
}

export interface OperatorPlanDiagnostics {
  exportChanges: number;
  files: number;
  importRewrites: number;
  /** Transformation kinds used, sorted. */
  kinds: PlannedTransformationKind[];
  manifestChanges: number;
  manifests: number;
  sourceFiles: number;
  /** Syntax forms behind the planned changes, with counts. */
  sourceForms: { form: string; count: number }[];
  testFiles: number;
  transformations: number;
  /** Source forms the planner met and cannot plan exactly, sorted. */
  unsupportedForms: string[];
}

/**
 * Precedence: `stale` (the sources no longer match the composition's facts)
 * > `unsupported` (a required transformation has no exact planning) >
 * `blocked` (a hard conflict or constraint) > `partial` (coherent, but an
 * action or gap is unrealized) > `ready` (every action realized, no blocker,
 * verification specified). `ready` means planning is complete, not that the
 * plan is safe to apply.
 */
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
  /** `plan:<hash>` over the composition id and fingerprint, transformation ids, file hashes, and versions. */
  id: string;
  importRewrites: PlannedImportRewrite[];
  inputs: OperatorPlanInput[];
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

export type OperatorExecutionPlanValidationStatus =
  | "valid"
  | "invalid"
  | "stale";

export interface OperatorExecutionPlanValidation {
  /** Files whose bytes differ from the plan's fingerprint. */
  changedFiles: string[];
  currentFingerprint?: string;
  cycles: string[][];
  fingerprint: string;
  planId: string;
  problems: string[];
  status: OperatorExecutionPlanValidationStatus;
}
