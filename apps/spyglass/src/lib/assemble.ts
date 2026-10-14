import { ANALYSIS_POLICY_VERSION } from "./config";
import type { PackageLocalReport } from "./package-local-types";
import { emptyUsage } from "./references";
import type { SurfaceReport, SurfaceSymbol } from "./types";
import { patchBooleanParameters } from "./workspace-derive";
import type { WorkspaceDerivedPackageFacts } from "./workspace-derive-types";

// V12.6 assembly: a `SurfaceReport` is the package-local report joined with
// the workspace-derived facts for the same package. Nothing is analyzed
// here — no files, no program, no Git — and field order follows the report
// the monolithic analyzer produced, so unchanged reports stay byte-identical.

export function assembleSurfaceReport(
  local: PackageLocalReport,
  derived: WorkspaceDerivedPackageFacts
): SurfaceReport {
  if (derived.path !== local.package.path) {
    throw new Error(
      `cannot assemble ${local.package.path}: derived facts belong to ${derived.path}`
    );
  }
  const symbols: SurfaceSymbol[] = local.symbols.map((symbol) => ({
    declarationFile: symbol.declarationFile,
    exported: symbol.exported,
    id: symbol.id,
    kind: symbol.kind,
    name: symbol.name,
    packagePublic: symbol.packagePublic,
    ...(derived.usage[symbol.id] ?? emptyUsage()),
  }));
  return {
    policyVersion: ANALYSIS_POLICY_VERSION,
    schemaVersion: 35,
    target: {
      ...(local.package.name !== undefined && { name: local.package.name }),
      boundaryType: local.package.boundaryType,
      path: local.package.path,
    },
    ...(local.anchor !== undefined && { anchor: local.anchor }),
    architecturalProfile: derived.architecturalProfile,
    boundaryInteractions: derived.boundaryInteractions,
    changeCoupling: derived.changeCoupling,
    changeRadius: derived.changeRadius,
    churn: derived.churn,
    conceptBehavioralLocality: derived.conceptBehavioralLocality,
    conceptInventory: derived.conceptInventory,
    conceptOverlap: derived.conceptOverlap,
    conceptOwnership: derived.conceptOwnership,
    dependencies: derived.dependencies,
    dependencyGravity: derived.dependencyGravity,
    evolutionaryPressure: derived.evolutionaryPressure,
    hotspots: derived.hotspots,
    ineligibleOperations: derived.ineligibleOperations,
    localComplexity: patchBooleanParameters(
      local.localComplexity,
      derived.booleanParameters
    ),
    operators: derived.operators,
    opportunities: derived.opportunities,
    plans: derived.plans,
    recenteringCandidates: derived.recenteringCandidates,
    structuralPressure: derived.structuralPressure,
    summary: {
      declaredSurfaceRatio: local.summary.declaredSurfaceRatio,
      exportUtilization: derived.summary.exportUtilization,
      externallyUsedSymbols: derived.summary.externallyUsedSymbols,
      externalSurfaceRatio: derived.summary.externalSurfaceRatio,
      moduleExportedSymbols: local.summary.moduleExportedSymbols,
      moduleOnlyExports: local.summary.moduleOnlyExports,
      packagePublicSymbols: local.summary.packagePublicSymbols,
      totalSymbols: local.summary.totalSymbols,
      unusedExternalExports: derived.summary.unusedExternalExports,
    },
    symbols,
  };
}
