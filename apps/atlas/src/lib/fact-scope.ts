import type { SemanticStage } from "./semantics-stages";
import type { SurfaceReport, SurfaceSymbol } from "./types";

// V12.6 fact locality. Package-local facts describe the package; workspace-
// derived facts describe the package's relationship to its current
// environment. The test: could the fact be computed the same way if the
// unchanged package were copied into a different workspace with different
// neighbours? Every `SurfaceReport` field is classified here, and the leak
// tests read this table rather than a list in someone's head.

export type SemanticFactScope = "package-local" | "workspace-derived";

/**
 * `mixed` records carry fields of both scopes; the sub-field tables below
 * say which. `package-local*` marks a field local in every respect but one
 * named in the note.
 */
export type SurfaceFieldScope = SemanticFactScope | "mixed";

export const SURFACE_REPORT_FIELD_SCOPES: Record<
  keyof SurfaceReport,
  SurfaceFieldScope
> = {
  anchor: "package-local",
  architecturalProfile: "workspace-derived",
  boundaryInteractions: "workspace-derived",
  changeCoupling: "workspace-derived",
  changeRadius: "workspace-derived",
  churn: "workspace-derived",
  conceptBehavioralLocality: "workspace-derived",
  /** Seeds are local; evidence, representations, and distribution are workspace-derived. */
  conceptInventory: "mixed",
  conceptOverlap: "workspace-derived",
  conceptOwnership: "workspace-derived",
  dependencies: "workspace-derived",
  /** Roles and file kinds are local; every graph measurement is workspace-derived. */
  dependencyGravity: "mixed",
  evolutionaryPressure: "workspace-derived",
  hotspots: "workspace-derived",
  ineligibleOperations: "workspace-derived",
  /** Local except `parameters.boolean`, which resolves annotation types workspace-wide. */
  localComplexity: "mixed",
  operators: "workspace-derived",
  opportunities: "workspace-derived",
  plans: "workspace-derived",
  policyVersion: "package-local",
  recenteringCandidates: "workspace-derived",
  schemaVersion: "package-local",
  structuralPressure: "workspace-derived",
  summary: "mixed",
  symbols: "mixed",
  target: "package-local",
};

export const SURFACE_SYMBOL_FIELD_SCOPES: Record<
  keyof SurfaceSymbol,
  SemanticFactScope
> = {
  access: "workspace-derived",
  consumerModules: "workspace-derived",
  consumerModuleUsage: "workspace-derived",
  consumerPackages: "workspace-derived",
  consumers: "workspace-derived",
  declarationFile: "package-local",
  exported: "package-local",
  externalImportSites: "workspace-derived",
  externalReferences: "workspace-derived",
  id: "package-local",
  kind: "package-local",
  name: "package-local",
  packagePublic: "package-local",
  primaryConsumerShare: "workspace-derived",
  usageContexts: "workspace-derived",
  usageNamespace: "workspace-derived",
};

export const SURFACE_SUMMARY_FIELD_SCOPES: Record<
  keyof SurfaceReport["summary"],
  SemanticFactScope
> = {
  declaredSurfaceRatio: "package-local",
  exportUtilization: "workspace-derived",
  externallyUsedSymbols: "workspace-derived",
  externalSurfaceRatio: "workspace-derived",
  moduleExportedSymbols: "package-local",
  moduleOnlyExports: "package-local",
  packagePublicSymbols: "package-local",
  totalSymbols: "package-local",
  unusedExternalExports: "workspace-derived",
};

/** Stage ownership: which analysis stages produce facts of each scope. */
export const PACKAGE_LOCAL_STAGES: readonly SemanticStage[] = [
  "packageLocalAnalysis",
];
export const WORKSPACE_DERIVED_STAGES: readonly SemanticStage[] = [
  "workspaceDerivation",
];

/**
 * Keys that name workspace-relative facts. A `PackageLocalReport` must not
 * contain any of them at any depth; the leak test walks the report for them.
 */
export const WORKSPACE_DERIVED_KEYS: readonly string[] = [
  "consumers",
  "consumerPackages",
  "consumerModules",
  "consumerModuleUsage",
  "externalReferences",
  "externalImportSites",
  "primaryConsumerShare",
  "exportUtilization",
  "externallyUsedSymbols",
  "dependencyGravity",
  "reach",
  "changeRadius",
  "changeCoupling",
  "churn",
  "hotspots",
  "conceptOverlap",
  "conceptOwnership",
  "conceptBehavioralLocality",
  "recenteringCandidates",
  "evolutionaryPressure",
  "structuralPressure",
  "boundaryInteractions",
  "architecturalProfile",
  "commitPercentile",
  "lineChurnPercentile",
  "analyzedAt",
];
