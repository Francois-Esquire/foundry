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

export const WORKSPACE_SURFACE_DERIVATION_SCHEMA_VERSION = 1;

export interface WorkspaceDerivedPackageFacts {
  architecturalProfile: ArchitecturalProfileReport;
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
  analyzedAt: string;
  diagnostics: WorkspaceDerivationDiagnostic[];
  packages: Record<string, WorkspaceDerivedPackageFacts>;
  policyVersion: number;
  profile: AnalysisProfile;
  schemaVersion: typeof WORKSPACE_SURFACE_DERIVATION_SCHEMA_VERSION;
  timing: WorkspaceDerivationTiming;
}
