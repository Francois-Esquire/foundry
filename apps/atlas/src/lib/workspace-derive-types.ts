import type { ExternalUsage } from "./references";
import type {
  AnalysisProfile,
  ArchitecturalProfileReport,
  BoundaryInteractionReport,
  ChangeCouplingReport,
  ChangeRadiusReport,
  ChurnReport,
  ConceptBehavioralLocalityReport,
  ConceptInventoryReport,
  ConceptOverlapReport,
  ConceptOwnershipReport,
  DependencyGravityReport,
  EvolutionaryPressureReport,
  HotspotReport,
  IneligibleOperation,
  OperatorSummary,
  RecenteringCandidateReport,
  ReductionOpportunity,
  ReductionPlan,
  StructuralPressureReport,
  SurfaceDependencies,
} from "./types";

// V12.6 workspace-derived facts: what a package means inside its current
// workspace. Ephemeral — recomputed every build from the local reports and
// never persisted on its own — so the version is a stage fingerprint input
// rather than a cache format.

export const WORKSPACE_SURFACE_DERIVATION_SCHEMA_VERSION = 1;

/** The workspace-derived half of a `SurfaceReport`; assembly joins it with the local half. */
export interface WorkspaceDerivedPackageFacts {
  architecturalProfile: ArchitecturalProfileReport;
  /**
   * `parameters.boolean` per function id as measured on the shared program;
   * the one local-complexity metric that can see another package's types.
   */
  booleanParameters: Record<string, number>;
  boundaryInteractions: BoundaryInteractionReport;
  changeCoupling: ChangeCouplingReport;
  changeRadius: ChangeRadiusReport;
  churn: ChurnReport;
  conceptBehavioralLocality: ConceptBehavioralLocalityReport;
  conceptInventory: ConceptInventoryReport;
  conceptOverlap: ConceptOverlapReport;
  conceptOwnership: ConceptOwnershipReport;
  dependencies: SurfaceDependencies;
  dependencyGravity: DependencyGravityReport;
  evolutionaryPressure: EvolutionaryPressureReport;
  hotspots: HotspotReport;
  ineligibleOperations: IneligibleOperation[];
  operators: OperatorSummary[];
  opportunities: ReductionOpportunity[];
  /** Repository-relative package path, matching `PackageLocalReport.package.path`. */
  path: string;
  plans: ReductionPlan[];
  recenteringCandidates: RecenteringCandidateReport;
  structuralPressure: StructuralPressureReport;
  summary: {
    externallyUsedSymbols: number;
    unusedExternalExports: number;
    externalSurfaceRatio: number;
    exportUtilization: number;
  };
  /** External usage per exported symbol id; absent symbols are unused. */
  usage: Record<string, ExternalUsage>;
}

interface WorkspaceDerivationDiagnostic {
  message: string;
  package: string;
}

export interface WorkspaceDerivationTiming {
  conceptsMs: number;
  cruiseMs: number;
  historyMs: number;
  overlapIndexMs: number;
  packagesMs: number;
  projectMs: number;
  referencesMs: number;
  symbolsMs: number;
  totalMs: number;
}

export interface WorkspaceSurfaceDerivation {
  /** The analysis clock; the only clock-dependent input. */
  analyzedAt: string;
  diagnostics: WorkspaceDerivationDiagnostic[];
  /** Keyed by repository-relative package path. */
  packages: Record<string, WorkspaceDerivedPackageFacts>;
  policyVersion: number;
  profile: AnalysisProfile;
  schemaVersion: typeof WORKSPACE_SURFACE_DERIVATION_SCHEMA_VERSION;
  timing: WorkspaceDerivationTiming;
}
