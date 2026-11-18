import type {
  ArchitecturalGravityProfile,
  ArchitecturalProfileSignal,
  ArchitecturalReviewDisposition,
  ArchitecturalReviewUncertaintyKind,
  ArchitecturalTensionKind,
  BehavioralLocalityModifier,
  BehavioralLocalityShape,
  ChurnFileKind,
  ConceptAssignability,
  ConceptConversion,
  ConceptDistributionShape,
  ConceptIdentity,
  ConceptNameAffinity,
  ConceptOverlapDimension,
  ConceptOverlapShape,
  ConceptOwnershipCenter,
  ConceptOwnershipTensionKind,
  ConceptPropertyOverlap,
  ConceptRelationshipKind,
  CouplingContext,
  DeclaredHome,
  DominatedScenario,
  EvolutionaryPressureKind,
  FileKind,
  HotspotSignal,
  MiscenteringSignal,
  ModuleRole,
  OwnershipAlignment,
  PackageShapeSignal,
  RecenteringScenarioKind,
  RecenteringStatus,
  ReviewedScenarioStatus,
  ScenarioConstraint,
  ScenarioEvidenceConfidence,
  ScenarioImpactStatus,
  ScenarioImpactUncertaintyKind,
  ScenarioStatus,
  ScenarioStructuralChangeKind,
  StaticPathRelation,
  StaticRelation,
  StructuralPressureKind,
  UsageNamespace,
} from "./types";
import type { WorkspaceConceptIntelligence } from "./workspace-concepts-types";
import type { WorkspaceGraphAnalysis } from "./workspace-graph-types";
import type { WorkspaceArchitecturalPatterns } from "./workspace-patterns-types";

export const WORKSPACE_SCHEMA_VERSION = 7;

export const SUPPORTED_PACKAGE_SCHEMAS: readonly number[] = [32, 33, 34, 35];

export interface WorkspaceProvenance {
  observedBy: string[];
}

interface WorkspaceHistoryWindow {
  analyzedAt: string;
  commitsAnalyzed: number;
  since?: string;
  windowDays: number | null;
}

export interface WorkspaceReportSource {
  anchored: boolean;
  history?: WorkspaceHistoryWindow;
  package: string;
  policyVersion?: number;
  provenance: { source: "analysis-report" };
  reportId: string;
  schemaVersion: number;
  target: string;
}

interface WorkspaceIdentity {
  packageCount: number;
  reportCount: number;
  root?: string;
}

interface WorkspacePackageSurface {
  consumerPackages: number;
  dependencyPackages: number;
  exportUtilization: number;
  externallyUsedSymbols: number;
  packagePublicSymbols: number;
  shapeSignals: PackageShapeSignal[];
  totalSymbols: number;
  unusedExternalExports: number;
}

export interface WorkspacePackage {
  analyzed: boolean;
  anchored: boolean;
  anchorReason?: string;
  gravity?: ArchitecturalGravityProfile;
  id: string;
  name: string;
  path?: string;
  provenance: WorkspaceProvenance;
  surface?: WorkspacePackageSurface;
}

interface WorkspacePackageIndex {
  packages: WorkspacePackage[];
}

interface WorkspaceGraphNode {
  analyzed: boolean;
  anchored: boolean;
  package: string;
  provenance: WorkspaceProvenance;
}

export interface WorkspaceModuleNode {
  fileKind?: FileKind;
  gravity?: {
    fanIn: number;
    fanOut: number;
    transitiveDependents: number;
    transitiveDependencies: number;
  };
  id: string;
  package?: string;
  provenance: WorkspaceProvenance;
  role?: ModuleRole;
}

export interface WorkspaceDependencyEdge {
  from: string;
  id: string;
  moduleEdges: number;
  provenance: WorkspaceProvenance;
  to: string;
  verified: boolean;
}

export interface WorkspaceModuleEdge {
  from: string;
  fromPackage: string;
  id: string;
  provenance: WorkspaceProvenance;
  to: string;
  toPackage: string;
  typeOnly?: boolean;
}

interface WorkspaceGraph {
  dependencyEdges: WorkspaceDependencyEdge[];
  moduleEdges: WorkspaceModuleEdge[];
  modules: WorkspaceModuleNode[];
  packages: WorkspaceGraphNode[];
}

type WorkspaceConceptAnalysis = "seed-report" | "foreign-only";

interface WorkspaceConceptObservation {
  role: "seed" | "overlap-partner";
  source: string;
}

interface WorkspaceConceptDistribution {
  moduleCount: number;
  packages: string[];
  primaryPackage?: string;
  primaryShare: number | null;
  references: number;
  shapes: ConceptDistributionShape[];
}

interface WorkspaceConceptParticipation {
  conversions: number;
  implementations: number;
  package: string;
  references: number;
  representations: number;
}

interface WorkspaceConceptOwnership {
  alignment: OwnershipAlignment;
  center: ConceptOwnershipCenter;
  participation: WorkspaceConceptParticipation[];
  tensions: ConceptOwnershipTensionKind[];
}

export interface WorkspaceConceptBehaviorPackage {
  contractBehaviors: number;
  conversionBehaviors: number;
  implementationBehaviors: number;
  package: string;
  sourceBehaviors: number;
  storyBehaviors: number;
  testBehaviors: number;
}

interface WorkspaceConceptLocality {
  anchored: boolean;
  behavior: WorkspaceConceptBehaviorPackage[];
  modifiers: BehavioralLocalityModifier[];
  moduleCount: number;
  packageBoundaryCount: number;
  packageCount: number;
  primaryPackage?: string;
  primaryPackageShare: number | null;
  shape: BehavioralLocalityShape;
  sourceModuleCount: number;
}

interface WorkspaceConceptEvolution {
  couplings: string[];
  hotspotModules: string[];
}

export interface WorkspaceConcept {
  analysis: WorkspaceConceptAnalysis;
  distribution?: WorkspaceConceptDistribution;
  evolution?: WorkspaceConceptEvolution;
  file: string;
  id: string;
  kind: ConceptIdentity["kind"];
  locality?: WorkspaceConceptLocality;
  name: string;
  observations: WorkspaceConceptObservation[];
  overlaps: string[];
  ownership?: WorkspaceConceptOwnership;
  package: string;
  provenance: WorkspaceProvenance;
  recentering?: { status: RecenteringStatus; findingId?: string };
  relationships?: Record<ConceptRelationshipKind, number>;
  representations?: {
    total: number;
    byPackage: { package: string; representations: number }[];
  };
}

export interface WorkspaceConceptOverlap {
  assignability?: ConceptAssignability;
  bidirectionalConversion: boolean;
  conversions: ConceptConversion[];
  crossPackage: boolean;
  dimensions: ConceptOverlapDimension[];
  id: string;
  left: ConceptIdentity;
  name?: ConceptNameAffinity;
  provenance: WorkspaceProvenance;
  right: ConceptIdentity;
  shapes: ConceptOverlapShape[];
  structure?: ConceptPropertyOverlap;
  verified: boolean;
}

interface WorkspaceConceptIndex {
  byPackage: Record<string, string[]>;
  concepts: WorkspaceConcept[];
  overlaps: WorkspaceConceptOverlap[];
}

export interface WorkspaceBoundaryPerspective {
  breadth: { sourceModules: number; destinationModules: number };
  distinctSymbols: number;
  importSites: number;
  moduleEdges: number;
  observedBy: string;
  usage: {
    namespace: UsageNamespace;
    typeOnlySymbols: number;
    valueOnlySymbols: number;
    bothSymbols: number;
  };
}

export interface WorkspaceBoundary {
  breadth: WorkspaceBoundaryPerspective["breadth"];
  from: string;
  id: string;
  importSites: number;
  moduleEdges: number;
  perspectives: {
    source?: WorkspaceBoundaryPerspective;
    destination?: WorkspaceBoundaryPerspective;
  };
  provenance: WorkspaceProvenance;
  surfaceCoverage: number | null;
  symbols: {
    distinct: number;
    packagePublic: number | null;
    references: number | null;
  };
  to: string;
  usage: WorkspaceBoundaryPerspective["usage"];
  verified: boolean;
}

interface WorkspaceBoundaryIndex {
  boundaries: WorkspaceBoundary[];
}

interface WorkspaceChurnObservation {
  additions: number;
  commits: number;
  deletions: number;
  linesChanged: number;
  source: string;
  window: string;
}

export interface WorkspaceFileChurn {
  additions: number;
  authors: number;
  commits: number;
  deletions: number;
  file: string;
  kind: ChurnFileKind;
  lastChangedAt?: string;
  linesChanged: number;
  observations: WorkspaceChurnObservation[];
  package?: string;
  provenance: WorkspaceProvenance;
}

export interface WorkspaceHotspot {
  commitPercentile: number;
  commits: number;
  complexityPercentile: number;
  file: string;
  kind: ChurnFileKind;
  package?: string;
  provenance: WorkspaceProvenance;
  signals: HotspotSignal[];
}

export interface WorkspaceCouplingPair {
  coChangeCommits: number;
  context: CouplingContext;
  id: string;
  jaccard: number;
  lastCoChangedAt?: string;
  left: string;
  leftCommits: number;
  leftConditional: number;
  leftPackage: string;
  provenance: WorkspaceProvenance;
  right: string;
  rightCommits: number;
  rightConditional: number;
  rightPackage: string;
  scope: "same-package" | "cross-package";
  staticPath: StaticPathRelation;
  staticRelation: StaticRelation;
  verified: boolean;
}

export interface WorkspacePackageCoupling {
  coChangeCommits: number;
  id: string;
  jaccard: number;
  left: string;
  leftCommits: number;
  leftConditional: number;
  provenance: WorkspaceProvenance;
  right: string;
  rightCommits: number;
  rightConditional: number;
  staticPath: StaticPathRelation;
  staticRelation: StaticRelation;
  verified: boolean;
}

export interface WorkspacePackageRadius {
  boundariesP50: number;
  boundaryCrossingRate: number;
  commits: number;
  crossPackageRate: number;
  filesP50: number;
  package: string;
  packagesP50: number;
  provenance: WorkspaceProvenance;
}

interface WorkspaceEvolutionIndex {
  churn: WorkspaceFileChurn[];
  couplings: WorkspaceCouplingPair[];
  hotspots: WorkspaceHotspot[];
  packageCouplings: WorkspacePackageCoupling[];
  radius: WorkspacePackageRadius[];
}

export interface WorkspacePackageArchitecture {
  anchored: boolean;
  boundaryPressure: { from: string; to: string; shape: string }[];
  evolutionaryPressure?: {
    historicalSupport: "adequate" | "insufficient";
    reinforced: EvolutionaryPressureKind[];
    tensions: ArchitecturalTensionKind[];
  };
  package: string;
  profileSignals: ArchitecturalProfileSignal[];
  provenance: WorkspaceProvenance;
  structuralPressure: StructuralPressureKind[];
}

export interface WorkspaceRecenteringFinding {
  anchored: boolean;
  concept: ConceptIdentity;
  declaredHome: DeclaredHome;
  evidenceConfidence: number;
  id: string;
  mismatch: number;
  observedCenters: { target: string; gravity: number; anchored: boolean }[];
  provenance: WorkspaceProvenance;
  signal: MiscenteringSignal;
}

export interface WorkspaceRecenteringScenario {
  conceptId: string;
  confidence: ScenarioEvidenceConfidence;
  constraints: ScenarioConstraint["kind"][];
  findingId: string;
  id: string;
  kind: RecenteringScenarioKind;
  proposedCenter: string;
  provenance: WorkspaceProvenance;
  resolved: boolean;
  status: ScenarioStatus;
}

export interface WorkspaceScenarioImpact {
  certainty: { certain: number; conditional: number; unknown: number };
  changes: ScenarioStructuralChangeKind[];
  findingId: string;
  provenance: WorkspaceProvenance;
  resolved: boolean;
  scenarioId: string;
  status: ScenarioImpactStatus;
  summary: string[];
  uncertainties: ScenarioImpactUncertaintyKind[];
  unmeasuredEdges: string[];
}

export interface WorkspaceArchitecturalReview {
  baselineScenarioId: string;
  conceptId: string;
  disposition: ArchitecturalReviewDisposition;
  dominated: DominatedScenario[];
  findingId: string;
  invalid: string[];
  provenance: WorkspaceProvenance;
  resolved: boolean;
  scenarios: { scenarioId: string; status: ReviewedScenarioStatus }[];
  unresolved: {
    kind: ArchitecturalReviewUncertaintyKind;
    scenarioIds: string[];
  }[];
  viable: string[];
}

interface WorkspaceRecenteringIndex {
  findings: WorkspaceRecenteringFinding[];
  impacts: WorkspaceScenarioImpact[];
  reviews: WorkspaceArchitecturalReview[];
  scenarios: WorkspaceRecenteringScenario[];
}

interface WorkspaceArchitectureIndex {
  packages: WorkspacePackageArchitecture[];
  recentering: WorkspaceRecenteringIndex;
}

export type WorkspaceConflictResolution =
  | "identical"
  | "target-scoped"
  | "preferred-authority"
  | "unresolved";

export interface WorkspaceConflict {
  entity: string;
  entityId: string;
  field: string;
  observations: { sourcePackage: string; value: unknown }[];
  resolution: WorkspaceConflictResolution;
}

export type WorkspaceDiagnosticKind =
  | "invalid-shape"
  | "unsupported-schema"
  | "missing-target"
  | "duplicate-source"
  | "ambiguous-target"
  | "unknown-policy"
  | "mixed-policy"
  | "population-mismatch"
  | "broken-reference"
  | "partial-coverage";

export interface WorkspaceDiagnostic {
  detail: string;
  kind: WorkspaceDiagnosticKind;
  source?: string;
}

export interface WorkspaceCoverage {
  complete: boolean;
  missingPackages: string[];
  packagesAnalyzed: number;
  packagesKnown: number;
  population?: number;
}

export type WorkspaceEntityKind =
  | "package"
  | "module"
  | "moduleEdge"
  | "dependencyEdge"
  | "boundary"
  | "concept"
  | "overlap"
  | "churn"
  | "hotspot"
  | "coupling"
  | "packageCoupling"
  | "finding"
  | "scenario"
  | "impact"
  | "review";

export interface WorkspaceObservationDensity {
  one: number;
  threePlus: number;
  two: number;
}

interface WorkspaceIngestionDiagnostics {
  canonical: Record<WorkspaceEntityKind, number>;
  canonicalBoundaries: number;
  canonicalConcepts: number;
  canonicalModules: number;
  canonicalPackages: number;
  conflicts: WorkspaceConflict[];
  coverage: WorkspaceCoverage;
  density: Record<WorkspaceEntityKind, WorkspaceObservationDensity>;
  diagnostics: WorkspaceDiagnostic[];
  duplicates: number;
  naive: Record<WorkspaceEntityKind, number>;
  reportsAccepted: number;
  reportsReceived: number;
  reportsRejected: number;
}

export interface WorkspaceReport {
  architecture: WorkspaceArchitectureIndex;
  boundaries: WorkspaceBoundaryIndex;
  concepts: WorkspaceConceptIndex;
  evolution: WorkspaceEvolutionIndex;
  graph: WorkspaceGraph;
  ingestion: WorkspaceIngestionDiagnostics;
  intelligence?: WorkspaceIntelligence;
  packages: WorkspacePackageIndex;
  sources: WorkspaceReportSource[];
  workspace: WorkspaceIdentity;
  workspaceSchemaVersion: number;
}

interface WorkspaceIntelligence {
  concepts?: WorkspaceConceptIntelligence;
  graph?: WorkspaceGraphAnalysis;
  patterns?: WorkspaceArchitecturalPatterns;
  policyVersion?: number;
}

export interface WorkspaceIngestOptions {
  root?: string;
  supportedSchemas?: readonly number[];
}
