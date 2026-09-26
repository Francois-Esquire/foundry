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

/**
 * V9.0 canonical workspace model. Package `SurfaceReport`s are observations
 * from one target's perspective; this model is their deterministic union,
 * keyed by ids the package reports already use. Versioned independently of
 * the package report schema.
 */
export const WORKSPACE_SCHEMA_VERSION = 7;

/**
 * Package report schemas this ingestion understands. 32 lacks
 * `policyVersion`; 33 lacks module `fileKind`; 34 lacks module-edge
 * `typeOnly` and internal edges.
 */
export const SUPPORTED_PACKAGE_SCHEMAS: readonly number[] = [32, 33, 34, 35];

export interface WorkspaceProvenance {
  /** Canonical package ids of the reports that observed the fact, sorted. */
  observedBy: string[];
}

export interface WorkspaceHistoryWindow {
  analyzedAt: string;
  commitsAnalyzed: number;
  since?: string;
  windowDays: number | null;
}

export interface WorkspaceReportSource {
  anchored: boolean;
  history?: WorkspaceHistoryWindow;
  package: string;
  /** Absent for schema-32 reports, which did not record it. */
  policyVersion?: number;
  provenance: { source: "analysis-report" };
  /** Deterministic fingerprint over target, versions, history window and summary counts. */
  reportId: string;
  schemaVersion: number;
  /** Root-relative target path. */
  target: string;
}

export interface WorkspaceIdentity {
  packageCount: number;
  reportCount: number;
  root?: string;
}

export interface WorkspacePackageSurface {
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
  /** A report for this package was ingested; false for packages known only as edge or concept endpoints. */
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

export interface WorkspacePackageIndex {
  packages: WorkspacePackage[];
}

export interface WorkspaceGraphNode {
  analyzed: boolean;
  anchored: boolean;
  package: string;
  provenance: WorkspaceProvenance;
}

export interface WorkspaceModuleNode {
  /** Absent only for modules no analyzed package owns. */
  fileKind?: FileKind;
  gravity?: {
    fanIn: number;
    fanOut: number;
    transitiveDependents: number;
    transitiveDependencies: number;
  };
  /** Root-relative path; already unique across the workspace. */
  id: string;
  package?: string;
  provenance: WorkspaceProvenance;
  role?: ModuleRole;
}

export interface WorkspaceDependencyEdge {
  from: string;
  /** `${from}→${to}` */
  id: string;
  moduleEdges: number;
  provenance: WorkspaceProvenance;
  to: string;
  /** Both endpoints' reports observed the edge and agree on `moduleEdges`. */
  verified: boolean;
}

export interface WorkspaceModuleEdge {
  from: string;
  fromPackage: string;
  /** `${from}→${to}` */
  id: string;
  provenance: WorkspaceProvenance;
  to: string;
  toPackage: string;
  /** Absent when the observing report predates schema 35. */
  typeOnly?: boolean;
}

export interface WorkspaceGraph {
  dependencyEdges: WorkspaceDependencyEdge[];
  moduleEdges: WorkspaceModuleEdge[];
  modules: WorkspaceModuleNode[];
  packages: WorkspaceGraphNode[];
}

export type WorkspaceConceptAnalysis = "seed-report" | "foreign-only";

export interface WorkspaceConceptObservation {
  role: "seed" | "overlap-partner";
  source: string;
}

export interface WorkspaceConceptDistribution {
  moduleCount: number;
  packages: string[];
  primaryPackage?: string;
  primaryShare: number | null;
  references: number;
  shapes: ConceptDistributionShape[];
}

/** One package's V7.3 participation counts; `behaviors` is left to locality, which separates source from test. */
export interface WorkspaceConceptParticipation {
  conversions: number;
  implementations: number;
  package: string;
  references: number;
  representations: number;
}

export interface WorkspaceConceptOwnership {
  alignment: OwnershipAlignment;
  center: ConceptOwnershipCenter;
  /** Sorted by package. */
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

export interface WorkspaceConceptLocality {
  anchored: boolean;
  /** Sorted by package. */
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

/** V6 history the seed report attached to the family's own members. Ids resolve into `evolution`. */
export interface WorkspaceConceptEvolution {
  /** Canonical coupling pair ids (`left|right`, files sorted) between two member files. */
  couplings: string[];
  /** Behavior modules that are V6.1 hotspots in the seed report. */
  hotspotModules: string[];
}

export interface WorkspaceConcept {
  /** `seed-report`: the declaring package's report was ingested and its target-scoped analyses are authoritative here. */
  analysis: WorkspaceConceptAnalysis;
  distribution?: WorkspaceConceptDistribution;
  evolution?: WorkspaceConceptEvolution;
  file: string;
  id: string;
  kind: ConceptIdentity["kind"];
  locality?: WorkspaceConceptLocality;
  name: string;
  observations: WorkspaceConceptObservation[];
  /** Canonical overlap pair ids this concept takes part in, sorted. */
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
  /** `${left.id}|${right.id}` with ids sorted; directional fields follow that orientation. */
  id: string;
  left: ConceptIdentity;
  name?: ConceptNameAffinity;
  provenance: WorkspaceProvenance;
  right: ConceptIdentity;
  shapes: ConceptOverlapShape[];
  structure?: ConceptPropertyOverlap;
  verified: boolean;
}

export interface WorkspaceConceptIndex {
  /** Declaring package → concept ids, both sorted. */
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

/**
 * One directional package boundary. The destination's report measures usage
 * of its own declared surface (symbol references); the source's report
 * counts its import declarations. Those are different populations, so each
 * is kept as a perspective; only `moduleEdges` is one shared fact. Canonical
 * counts come from the destination when present, else the source.
 */
export interface WorkspaceBoundary {
  breadth: WorkspaceBoundaryPerspective["breadth"];
  from: string;
  /** `${from}→${to}` */
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
    /** Destination-only facts; null when only the source observed the boundary. */
    packagePublic: number | null;
    references: number | null;
  };
  to: string;
  usage: WorkspaceBoundaryPerspective["usage"];
  /** Both perspectives observed the boundary and agree on `moduleEdges`. */
  verified: boolean;
}

export interface WorkspaceBoundaryIndex {
  boundaries: WorkspaceBoundary[];
}

export interface WorkspaceChurnObservation {
  additions: number;
  commits: number;
  deletions: number;
  linesChanged: number;
  source: string;
  /** `reportId` of the observing source; equal windows share a fingerprint. */
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
  /** `${left}|${right}` with files sorted; conditionals follow that orientation. */
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
  /** `${left}|${right}` with packages sorted. */
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

/** Target-scoped: a package's own commits, never merged across packages. */
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

export interface WorkspaceEvolutionIndex {
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
  /** The finding exists in the canonical index. */
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
  /** Distinct V8.3 uncertainty kinds, sorted. */
  uncertainties: ScenarioImpactUncertaintyKind[];
  /** Package edge ids the simulation could not measure, sorted. */
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

export interface WorkspaceRecenteringIndex {
  findings: WorkspaceRecenteringFinding[];
  impacts: WorkspaceScenarioImpact[];
  reviews: WorkspaceArchitecturalReview[];
  scenarios: WorkspaceRecenteringScenario[];
}

export interface WorkspaceArchitectureIndex {
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
  /** Packages named anywhere in the ingested reports. */
  packagesKnown: number;
  /** Workspace package count the reports' dependency population agreed on. */
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

export interface WorkspaceIngestionDiagnostics {
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
  /** Observation count before deduplication, per entity kind. */
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
  /** Derived layers over the canonical facts above; absent until computed. */
  intelligence?: WorkspaceIntelligence;
  packages: WorkspacePackageIndex;
  sources: WorkspaceReportSource[];
  workspace: WorkspaceIdentity;
  workspaceSchemaVersion: number;
}

/**
 * Derived workspace layers. `policyVersion` is
 * `WORKSPACE_INTELLIGENCE_POLICY_VERSION`, the thresholds these layers were
 * computed under; independent of the package `ANALYSIS_POLICY_VERSION`.
 */
export interface WorkspaceIntelligence {
  concepts?: WorkspaceConceptIntelligence;
  graph?: WorkspaceGraphAnalysis;
  patterns?: WorkspaceArchitecturalPatterns;
  policyVersion?: number;
}

export interface WorkspaceIngestOptions {
  /** Recorded on the identity only; never used for ids. */
  root?: string;
  /** Package report schemas to accept; defaults to `SUPPORTED_PACKAGE_SCHEMAS`. */
  supportedSchemas?: readonly number[];
}
