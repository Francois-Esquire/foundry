import type { SurfaceReport, SurfaceSymbol } from "./types";

// V12.6 fact locality. Package-local facts describe the package; workspace-
// derived facts describe the package's relationship to its current
// environment. The test: could the fact be computed the same way if the
// unchanged package were copied into a different workspace with different
// neighbours? Every `SurfaceReport` field is classified here, and the leak
// tests read this table rather than a list in someone's head.

export type SemanticFactScope = "package-local" | "workspace-derived";
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
