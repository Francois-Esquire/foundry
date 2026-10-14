import type {
  ArchitecturalReviewDisposition,
  ArchitecturalReviewUncertaintyKind,
  BehavioralLocalityModifier,
  BehavioralLocalityShape,
  ConceptDistributionShape,
  ConceptOverlapShape,
  ConceptOwnershipTensionKind,
  ConceptSeedKind,
  CouplingContext,
  MiscenteringSignal,
  OwnershipAlignment,
  PackageShapeSignal,
  RecenteringScenarioKind,
  RecenteringStatus,
  ScenarioConstraint,
  ScenarioEvidenceConfidence,
  ScenarioImpactStatus,
  ScenarioImpactUncertaintyKind,
  ScenarioStatus,
  ScenarioStructuralChangeKind,
  StaticPathRelation,
} from "./types";
import type {
  WorkspaceBoundaryConceptLoad,
  WorkspaceConceptCoverage,
  WorkspaceConceptExtent,
  WorkspaceConceptFlow,
  WorkspaceConceptIntelligence,
  WorkspaceConceptPackageRole,
  WorkspaceConceptPairTopology,
  WorkspaceConceptPath,
  WorkspaceConceptPlacement,
  WorkspaceConceptPresence,
  WorkspaceConceptPropagation,
  WorkspaceConceptShape,
  WorkspaceConceptSpan,
  WorkspacePackageConceptRoleSummary,
} from "./workspace-concepts-types";
import type {
  WorkspaceGraphAnalysis,
  WorkspaceGraphCertainty,
  WorkspacePackageGraphAnalysis,
  WorkspacePackageGraphEdge,
  WorkspacePackageGraphRole,
} from "./workspace-graph-types";
import type {
  WorkspaceArchitecturalPatterns,
  WorkspaceArchitecturalRoleKind,
  WorkspaceBoundaryPattern,
  WorkspaceBoundaryPatternKind,
  WorkspaceDirectionPattern,
  WorkspaceEvolutionaryPatternKind,
  WorkspacePackagePairPattern,
  WorkspacePackageRoleProfile,
  WorkspacePatternCoverage,
  WorkspacePatternEvidenceStrength,
} from "./workspace-patterns-types";
import type {
  WorkspaceArchitecturalReview,
  WorkspaceBoundary,
  WorkspaceConcept,
  WorkspaceConceptOverlap,
  WorkspaceRecenteringFinding,
  WorkspaceRecenteringScenario,
  WorkspaceReport,
  WorkspaceScenarioImpact,
} from "./workspace-types";

/**
 * V9.4 workspace projections: question-specific, renderer-neutral views
 * derived from the V9.0–V9.3 intelligence already attached to a
 * `WorkspaceReport`. Every entity keeps its canonical id, every count is
 * copied (never recomputed), and nothing here infers a role, pattern, or
 * recommendation. No layout, no style, no ranking score.
 */
export const WORKSPACE_PROJECTION_SCHEMA_VERSION = 1;

type WorkspaceProjectionScope =
  | "workspace"
  | "package"
  | "concept"
  | "boundary"
  | "pattern";

export type ProjectionEntityKind =
  | "package"
  | "module"
  | "concept"
  | "boundary"
  | "pattern"
  | "review"
  | "scenario"
  | "finding"
  | "coupling"
  | "overlap";

type ProjectionEvidenceSource =
  | "workspace"
  | "graph"
  | "concept"
  | "pattern"
  | "v8-review";

/** A pointer into the canonical model; never a copy of the fact. */
export interface ProjectionEvidenceRef {
  entityIds: string[];
  kind: string;
  source: ProjectionEvidenceSource;
  value?: number | string | boolean;
}

export type ProjectionDetail = "summary" | "standard" | "evidence";

/** Analyzed-package coverage, restated on every top-level projection. */
export interface ProjectionCoverage {
  certainty: WorkspaceGraphCertainty;
  missingPackages: string[];
  packagesAnalyzed: number;
  packagesKnown: number;
}

/** Headline → support → detail → evidence disclosure for one statement. */
interface ProjectionInsight {
  detail?: string[];
  evidenceRefs: ProjectionEvidenceRef[];
  headline: string;
  support: { count?: number; entityIds?: string[] };
}

export interface WorkspaceLimitationProjection {
  detail: string;
  entities: string[];
  kind: string;
  scope: WorkspaceProjectionScope;
}

/** The same four layers V9.3 consumed, plus indexes built once. */
export interface WorkspaceProjectionContext {
  concepts: WorkspaceConceptIntelligence;
  graph: WorkspaceGraphAnalysis;
  /** Serializable id tables. */
  index: WorkspaceProjectionIndex;
  /** In-memory maps over canonical entities; never serialized. */
  lookup: WorkspaceProjectionLookup;
  patterns: WorkspaceArchitecturalPatterns;
  workspace: WorkspaceReport;
}

export interface WorkspaceProjectionLookup {
  boundaryById: Map<string, WorkspaceBoundary>;
  boundaryPatternById: Map<string, WorkspaceBoundaryPattern>;
  conceptById: Map<string, WorkspaceConcept>;
  edgeById: Map<string, WorkspacePackageGraphEdge>;
  findingById: Map<string, WorkspaceRecenteringFinding>;
  graphNodeById: Map<string, WorkspacePackageGraphAnalysis>;
  impactByScenario: Map<string, WorkspaceScenarioImpact>;
  loadByBoundary: Map<string, WorkspaceBoundaryConceptLoad>;
  overlapById: Map<string, WorkspaceConceptOverlap>;
  pairPatternById: Map<string, WorkspacePackagePairPattern>;
  pairTopologyById: Map<string, WorkspaceConceptPairTopology>;
  patternById: Map<string, WorkspacePatternIndexEntry>;
  placementById: Map<string, WorkspaceConceptPlacement>;
  profileById: Map<string, WorkspacePackageRoleProfile>;
  reviewByConcept: Map<string, WorkspaceArchitecturalReview>;
  roleSummaryById: Map<string, WorkspacePackageConceptRoleSummary>;
  scenarioById: Map<string, WorkspaceRecenteringScenario>;
  scenariosByFinding: Map<string, WorkspaceRecenteringScenario[]>;
  seamIds: Set<string>;
}

type WorkspacePatternFamily =
  | "package-role"
  | "package-pair"
  | "boundary"
  | "concept"
  | "evolutionary";

/** One V9.3 pattern under a family-prefixed id, so every family shares one namespace. */
export interface WorkspacePatternIndexEntry {
  boundaries: string[];
  conceptCount: number;
  concepts: string[];
  coverage: WorkspacePatternCoverage;
  family: WorkspacePatternFamily;
  id: string;
  kinds: string[];
  packages: string[];
  /** V9.3's own id (package for roles, boundary id for boundary patterns). */
  sourceId: string;
  strength: WorkspacePatternEvidenceStrength;
}

/** Lookup tables built once per context; serialization optional. */
export interface WorkspaceProjectionIndex {
  boundariesByPackage: Record<string, string[]>;
  conceptsByPackage: Record<string, string[]>;
  entities: WorkspaceQueryEntity[];
  /** Finding → gravity center (V9.3 definition), when one exists. */
  gravityCenterByFinding: Record<string, string>;
  patterns: WorkspacePatternIndexEntry[];
  patternsByBoundary: Record<string, string[]>;
  patternsByConcept: Record<string, string[]>;
  patternsByPackage: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// OVERVIEW

interface ProjectionSummary {
  count: number;
  entityId: string;
  entityKind: ProjectionEntityKind;
  kinds: string[];
  strength?: WorkspacePatternEvidenceStrength;
}

interface WorkspaceReviewTotals {
  credibleAlternatives: number;
  dominatedBaselines: number;
  insufficientEvidence: number;
  intentBlocked: number;
  preserveCurrent: number;
  reviewed: number;
  tradeoffs: number;
}

export interface WorkspaceOverviewProjection {
  architecture: {
    packageRoles: ProjectionSummary[];
    conceptPatterns: ProjectionSummary[];
    boundaryPatterns: ProjectionSummary[];
    statements: { kind: string; detail: string; patternIds: string[] }[];
    strength: { strong: number; moderate: number; limited: number };
  };
  coverage: ProjectionCoverage;
  limitations: WorkspaceLimitationProjection[];
  policyVersion: number | null;
  projectionSchemaVersion: number;
  reviews: WorkspaceReviewTotals;
  topology: {
    sources: string[];
    sinks: string[];
    isolated: string[];
    articulation: string[];
    maxDepth: number;
    components: number;
    cycles: number;
    seams: string[];
  };
  workspace: {
    packages: number;
    analyzedPackages: number;
    modules: number;
    concepts: number;
    authoritativeConcepts: number;
    boundaries: number;
    conceptBearingBoundaries: number;
    overlapPairs: number;
    conversionPairs: number;
  };
  workspaceSchemaVersion: number;
}

// ---------------------------------------------------------------------------
// PACKAGE

export interface ArchitecturalRoleProjection {
  conceptCount: number;
  conceptIds: string[];
  coverage: WorkspacePatternCoverage;
  kind: WorkspaceArchitecturalRoleKind;
  patternId: string;
  sourcePackages: string[];
  strength: WorkspacePatternEvidenceStrength;
}

export type ConceptDirectionRole =
  | "implementation"
  | "behavior"
  | "representation"
  | "usage"
  | "conversion";

/**
 * Semantic direction (`from` declares, `to` holds the role) with the static
 * dependency direction kept as its own field. The two regularly disagree:
 * an implementation imports its contract.
 */
export interface ConceptDirectionProjection {
  concepts: string[];
  count: number;
  dependencyPath: { forward: number | null; reverse: number | null };
  from: string;
  id: string;
  role: ConceptDirectionRole;
  staticDependencyDirection: "forward" | "reverse" | "usage-only" | "none";
  to: string;
}

interface BoundarySummaryProjection {
  boundaryId: string;
  conceptCount: number;
  direction: "outgoing" | "incoming";
  from: string;
  importSites: number | null;
  moduleEdges: number;
  patterns: WorkspaceBoundaryPatternKind[];
  seam: boolean;
  severedPairs: number | null;
  to: string;
}

export interface WorkspaceReviewContextProjection {
  credibleAlternatives: string[];
  dispositions: Partial<Record<ArchitecturalReviewDisposition, number>>;
  dominatedBaselines: string[];
  dominatingKinds: Partial<Record<RecenteringScenarioKind, number>>;
  preserved: string[];
  reviewed: number;
}

export interface WorkspacePackageReviewProjection {
  /** Reviews of concepts declared here. */
  asDeclaringPackage?: WorkspaceReviewContextProjection;
  /** Reviews whose gravity center is this package. */
  asGravityCenter?: WorkspaceReviewContextProjection;
  /** Declared → gravity-center directions touching this package. */
  directions: {
    from: string;
    to: string;
    reviews: WorkspaceReviewContextProjection;
  }[];
}

export interface WorkspacePackageProjection {
  analyzed: boolean;
  anchored: boolean;
  anchorReason?: string;
  boundaries: BoundarySummaryProjection[];
  cautions: WorkspaceLimitationProjection[];
  concepts: {
    declared: number;
    declaredCrossPackage: number;
    semanticCenters: number;
    implementationCenters: number;
    behaviorCenters: number;
    representationCenters: number;
    usageCenters: number;
    evolutionCenters: number;
    participating: {
      total: number;
      implementing: number;
      behaving: number;
      representing: number;
      using: number;
      converting: number;
    };
    foreign: {
      implemented: number;
      behaved: number;
      represented: number;
      used: number;
      converted: number;
      sources: number;
    };
    conversionsOwned: number;
  };
  coverage: ProjectionCoverage;
  evidenceRefs?: ProjectionEvidenceRef[];
  graph?: {
    role: WorkspacePackageGraphRole;
    layer: number;
    component: string;
    cycle: boolean;
    fanIn: number;
    fanOut: number;
    dependentReach: number;
    dependencyReach: number;
    dependentReachShare: number;
    dependencyReachShare: number;
    betweenness: number;
    articulation: boolean;
  };
  incomingDirections: ConceptDirectionProjection[];
  name: string;
  outgoingDirections: ConceptDirectionProjection[];
  package: string;
  patterns: string[];
  profileSignals: string[];
  reviews: WorkspacePackageReviewProjection;
  roles: ArchitecturalRoleProjection[];
  surface?: {
    totalSymbols: number;
    packagePublicSymbols: number;
    externallyUsedSymbols: number;
    exportUtilization: number;
    consumerPackages: number;
    dependencyPackages: number;
    shapeSignals: PackageShapeSignal[];
  };
}

// ---------------------------------------------------------------------------
// CONCEPT

/** A share with its numerator and denominator; never the ratio alone. */
export interface ProjectionShare {
  /** Null when the canonical model kept only the share. */
  count: number | null;
  package: string;
  share: number | null;
  total: number;
}

/** Field-picked from the standard package projection; never recomputed. */
export interface WorkspacePackageSummaryProjection {
  analyzed: boolean;
  boundaries: number;
  cautions: string[];
  concepts: { declared: number; participating: number };
  coverage: ProjectionCoverage;
  directions: { incoming: number; outgoing: number };
  package: string;
  patterns: number;
  reviewed: number;
  roles: {
    kind: WorkspaceArchitecturalRoleKind;
    conceptCount: number;
    strength: WorkspacePatternEvidenceStrength;
  }[];
}

/** Field-picked from the standard concept projection; never recomputed. */
export interface WorkspaceConceptSummaryProjection {
  boundaries: number;
  cautions: string[];
  centers?: {
    semantic?: string;
    representation?: string;
    usage?: string;
    behavior?: string;
    implementations: string[];
  };
  concept: WorkspaceConceptProjection["concept"];
  coverage: WorkspaceConceptCoverage;
  localityShape?: BehavioralLocalityShape;
  ownershipAlignment?: OwnershipAlignment;
  packages: number;
  patterns: number;
  propagation: WorkspaceConceptPropagation;
  reviewDisposition?: ArchitecturalReviewDisposition;
  shapes: WorkspaceConceptShape[];
}

interface ConceptParticipationProjection {
  contractBehaviors: number;
  conversionBehaviors: number;
  conversions: number;
  implementationBehaviors: number;
  implementations: number;
  layer: number | null;
  package: string;
  references: number;
  representations: number;
  roles: WorkspaceConceptPackageRole[];
  sourceBehaviors: number;
  storyBehaviors: number;
  testBehaviors: number;
}

interface ConceptEdgeProjection {
  alternativeRoutes: number;
  from: string;
  fromDeclared: boolean;
  id: string;
  importSites: number | null;
  moduleEdges: number;
  references: number | null;
  roles: string[];
  seam: boolean;
  severedPairs: number;
  to: string;
  toDeclared: boolean;
}

export interface ConceptRelationshipProjection {
  bidirectionalConversion: boolean;
  conversions: {
    function: string;
    package: string | null;
    direction: "outgoing" | "incoming";
  }[];
  crossPackage: boolean;
  other: string;
  otherName: string;
  otherPackage: string;
  pair: string;
  path?: {
    forward: number | null;
    reverse: number | null;
    directEdge: string | null;
  };
  shapes: ConceptOverlapShape[];
}

export interface ConceptCouplingProjection {
  coChangeCommits: number;
  context: CouplingContext;
  dependencyPath: { forward: number | null; reverse: number | null };
  id: string;
  jaccard: number;
  left: string;
  leftPackage: string;
  right: string;
  rightPackage: string;
  scope: "same-package" | "cross-package";
  staticPath: StaticPathRelation;
}

export interface WorkspaceScenarioProjection {
  confidence: ScenarioEvidenceConfidence;
  constraints: ScenarioConstraint["kind"][];
  id: string;
  impact?: {
    status: ScenarioImpactStatus;
    certainty: { certain: number; conditional: number; unknown: number };
    changes: ScenarioStructuralChangeKind[];
    uncertainties: ScenarioImpactUncertaintyKind[];
    unmeasuredEdges: string[];
  };
  kind: RecenteringScenarioKind;
  proposedCenter: string;
  status: ScenarioStatus;
}

/** The V8.4 chain, dispositions verbatim; never an imperative. */
export interface WorkspaceReviewProjection {
  baselineDominated: boolean;
  baselineScenarioId: string;
  conceptId: string;
  declaredPackage: string;
  disposition: ArchitecturalReviewDisposition;
  dominatedScenarios: { scenarioId: string; dominatedBy: string }[];
  dominatingKinds: RecenteringScenarioKind[];
  findingId: string;
  gravityCenter: string | null;
  invalidScenarios: string[];
  unresolved: {
    kind: ArchitecturalReviewUncertaintyKind;
    scenarioIds: string[];
  }[];
  viableScenarios: string[];
}

export interface WorkspaceConceptProjection {
  cautions: WorkspaceLimitationProjection[];
  centers?: {
    semantic?: string;
    representation?: string;
    usage?: string;
    behavior?: string;
    evolution?: string;
    implementations: string[];
    layers: {
      semantic?: number;
      representation?: number;
      usage?: number;
      behavior?: number;
    };
  };
  concept: {
    id: string;
    name: string;
    kind: ConceptSeedKind;
    package: string;
    file: string;
  };
  coverage: WorkspaceConceptCoverage;
  distribution?: {
    shapes: ConceptDistributionShape[];
    packages: number;
    modules: number;
    references: ProjectionShare | null;
    representations: ProjectionShare | null;
    sourceBehavior: ProjectionShare | null;
  };
  evidenceRefs?: ProjectionEvidenceRef[];
  evolution?: {
    strongMemberCouplings: ConceptCouplingProjection[];
    contextualCouplings: number;
    crossPackageCouplings: number;
    coChangeCommits: number;
    hotspotModules: string[];
    hotspotPackages: string[];
    historicallyActivePackages: string[];
  };
  extent: WorkspaceConceptExtent;
  flow: WorkspaceConceptFlow;
  locality?: {
    shape: BehavioralLocalityShape;
    modifiers: BehavioralLocalityModifier[];
    moduleCount: number;
    sourceModuleCount: number;
    packageCount: number;
    packageBoundaryCount: number;
    anchored: boolean;
    behavior: {
      source: number;
      test: number;
      story: number;
      contract: number;
      implementation: number;
      conversion: number;
    };
  };
  ownership?: {
    alignment: OwnershipAlignment;
    tensions: ConceptOwnershipTensionKind[];
  };
  participation: ConceptParticipationProjection[];
  patterns: string[];
  presence: WorkspaceConceptPresence;
  propagation: WorkspaceConceptPropagation;
  recentering?: {
    status: RecenteringStatus;
    finding?: {
      id: string;
      signal: MiscenteringSignal;
      mismatch: number;
      evidenceConfidence: number;
      observedCenters: { target: string; gravity: number }[];
      anchored: boolean;
    };
    scenarios: WorkspaceScenarioProjection[];
    review?: WorkspaceReviewProjection;
  };
  relationships: {
    overlaps: ConceptRelationshipProjection[];
    conversionPairs: number;
    overlapPairs: number;
  };
  shapes: WorkspaceConceptShape[];
  span: WorkspaceConceptSpan;
  topology: {
    participatingPackages: string[];
    unknownPackages: string[];
    layers: { package: string; layer: number | null }[];
    edges: ConceptEdgeProjection[];
    usageOnlyEdges: string[];
    paths: WorkspaceConceptPath[];
    disconnectedPackages: string[];
    components: string[];
  };
}

// ---------------------------------------------------------------------------
// BOUNDARY

export interface WorkspaceBoundaryProjection {
  boundaryId: string;
  cautions: WorkspaceLimitationProjection[];
  concepts: {
    total: number;
    semanticUse: number;
    behavior: number;
    implementation: number;
    representation: number;
    conversion: number;
    conceptIds: string[];
  };
  coverage: ProjectionCoverage;
  evidenceRefs?: ProjectionEvidenceRef[];
  evolution?: {
    patternId: string;
    kinds: WorkspaceEvolutionaryPatternKind[];
    couplings: string[];
    concepts: string[];
    coChangeCommits: number;
  };
  from: string;
  layers: { from: number | null; to: number | null };
  patterns: {
    kinds: WorkspaceBoundaryPatternKind[];
    patternId: string | null;
    strength: WorkspacePatternEvidenceStrength | null;
    coverage: WorkspacePatternCoverage | null;
  };
  ratios: {
    conceptsPerImportSite: {
      value: number | null;
      concepts: number;
      importSites: number;
    };
  };
  structure: {
    inPackageGraph: boolean;
    severedPairs: number | null;
    alternativeRoutes: number | null;
    weakBridge: boolean;
    seam: boolean;
    betweenness: number | null;
  };
  to: string;
  verified: boolean;
  volume: {
    moduleEdges: number;
    importSites: number;
    references: number | null;
    distinctSymbols: number;
    packagePublicSymbols: number | null;
    surfaceCoverage: number | null;
    usage: {
      typeOnlySymbols: number;
      valueOnlySymbols: number;
      bothSymbols: number;
    };
    breadth: { sourceModules: number; destinationModules: number };
  };
}

// ---------------------------------------------------------------------------
// PATTERN

export interface WorkspacePatternProjection {
  boundaries: string[];
  cautions: WorkspaceLimitationProjection[];
  conceptCount: number;
  concepts: string[];
  coverage: WorkspacePatternCoverage;
  evidenceRefs?: ProjectionEvidenceRef[];
  family: WorkspacePatternFamily;
  id: string;
  insight: ProjectionInsight;
  kinds: string[];
  packages: string[];
  reviews?: WorkspaceReviewContextProjection;
  strength: WorkspacePatternEvidenceStrength;
  structure: Record<string, string | string[] | number | boolean | null>;
}

// ---------------------------------------------------------------------------
// GRAPH

export type WorkspaceGraphPreset =
  | "architecture-overview"
  | "dependency-topology"
  | "structural-seam"
  | "implementation-flow"
  | "behavior-flow"
  | "representation-flow"
  | "usage-flow"
  | "conversion-flow"
  | "architecture-review";

export interface WorkspaceGraphProjectionNode {
  analyzed: boolean;
  anchored: boolean;
  cautions: string[];
  graphRole: WorkspacePackageGraphRole | null;
  id: string;
  kind: "package";
  label: string;
  layer: number | null;
  metrics: {
    fanIn: number;
    fanOut: number;
    declaredConcepts: number;
    participatingConcepts: number;
  };
  roles: WorkspaceArchitecturalRoleKind[];
}

export interface WorkspaceDependencyEdgeProjection {
  concepts: {
    total: number;
    semanticUse: number;
    behavior: number;
    implementation: number;
    representation: number;
    conversion: number;
  };
  dependency: {
    moduleEdges: number;
    importSites: number | null;
    references: number | null;
  };
  from: string;
  id: string;
  kind: "dependency";
  patterns: WorkspaceBoundaryPatternKind[];
  structure: {
    severedPairs: number;
    alternativeRoutes: number;
    weakBridge: boolean;
    seam: boolean;
  };
  to: string;
}

export interface WorkspaceDirectionEdgeProjection {
  concepts: { count: number; conceptIds: string[] };
  from: string;
  id: string;
  kind: "direction";
  pairPatterns: WorkspaceDirectionPattern[];
  role: ConceptDirectionRole;
  staticDependencyDirection: ConceptDirectionProjection["staticDependencyDirection"];
  to: string;
}

export interface WorkspaceReviewEdgeProjection {
  /** Declaring package → gravity center. */
  from: string;
  id: string;
  kind: "review";
  reviews: WorkspaceReviewContextProjection;
  to: string;
}

export type WorkspaceGraphProjectionEdge =
  | WorkspaceDependencyEdgeProjection
  | WorkspaceDirectionEdgeProjection
  | WorkspaceReviewEdgeProjection;

interface WorkspaceGraphProjectionGroup {
  id: string;
  kind: "layer" | "component";
  members: string[];
}

export interface WorkspaceGraphProjection {
  edges: WorkspaceGraphProjectionEdge[];
  groups: WorkspaceGraphProjectionGroup[];
  metadata: {
    scope: "workspace";
    preset: WorkspaceGraphPreset;
    edgeSource: string;
    filter: WorkspaceGraphFilter;
    coverage: ProjectionCoverage;
  };
  nodes: WorkspaceGraphProjectionNode[];
}

export interface WorkspaceGraphFilter {
  /** Keep only nodes touching a kept edge. */
  connectedOnly?: boolean;
  minConcepts?: number;
  packages?: string[];
}

// ---------------------------------------------------------------------------
// CONCEPT GRAPH

export type ConceptGraphEdgeKind =
  | "declared-in"
  | "implemented-in"
  | "behavior-in"
  | "represented-in"
  | "used-in"
  | "converted-in"
  | "overlap"
  | "dependency";

export interface ConceptGraphNode {
  focus: boolean;
  id: string;
  kind: "concept" | "package";
  label: string;
  layer?: number | null;
  package?: string;
}

export interface ConceptGraphEdge {
  conversion?: boolean;
  from: string;
  id: string;
  importSites?: number | null;
  kind: ConceptGraphEdgeKind;
  moduleEdges?: number;
  shapes?: ConceptOverlapShape[];
  to: string;
}

export interface WorkspaceConceptGraphProjection {
  concept: string;
  edges: ConceptGraphEdge[];
  metadata: { scope: "concept"; coverage: ProjectionCoverage };
  nodes: ConceptGraphNode[];
}

// ---------------------------------------------------------------------------
// MATRIX

type WorkspaceMatrixKind =
  | "package-concept-roles"
  | "package-direction"
  | "boundary-concept-load"
  | "review";

type PackageDirectionMetric = ConceptDirectionRole;

type BoundaryLoadMetric =
  | "concepts"
  | "importSites"
  | "moduleEdges"
  | "severedPairs"
  | "behavior"
  | "implementation"
  | "representation"
  | "semanticUse"
  | "conversion";

type ReviewMatrixMetric =
  | "reviewed"
  | "credibleAlternatives"
  | "dominatedBaselines"
  | "preserveCurrent"
  | "insufficientEvidence";

export type WorkspaceMatrixMetric =
  | { kind: "package-concept-roles" }
  | { kind: "package-direction"; metric: PackageDirectionMetric }
  | { kind: "boundary-concept-load"; metric: BoundaryLoadMetric }
  | { kind: "review"; metric: ReviewMatrixMetric };

export interface ProjectionAxisEntity {
  id: string;
  kind: ProjectionEntityKind | "role";
  label: string;
}

export interface WorkspaceMatrixCell {
  column: string;
  entityIds?: string[];
  row: string;
  value: number;
}

/** Sparse; a missing cell is zero. Heatmap-ready as is. */
export interface WorkspaceMatrixProjection {
  cells: WorkspaceMatrixCell[];
  columns: ProjectionAxisEntity[];
  coverage: ProjectionCoverage;
  id: string;
  metric: WorkspaceMatrixMetric;
  metricLabel: string;
  rows: ProjectionAxisEntity[];
}

// ---------------------------------------------------------------------------
// RANKED LISTS

type PackageRankMetric =
  | "declaredConcepts"
  | "semanticCenters"
  | "implementationCenters"
  | "behaviorCenters"
  | "representationCenters"
  | "usageCenters"
  | "foreignImplemented"
  | "foreignUsed"
  | "roleCount"
  | "fanIn"
  | "fanOut"
  | "dependentReach"
  | "dependencyReach";

type BoundaryRankMetric =
  | "concepts"
  | "importSites"
  | "moduleEdges"
  | "severedPairs"
  | "behaviorConcepts"
  | "implementationConcepts"
  | "conceptsPerImportSite";

type ConceptRankMetric =
  | "packages"
  | "boundaries"
  | "responsibilityLayerSpan"
  | "behaviorLayerSpan"
  | "implementationPackages"
  | "referencePackages"
  | "crossPackageCouplings";

export type WorkspaceRankQuery =
  | { kind: "packages"; metric: PackageRankMetric; limit?: number }
  | { kind: "boundaries"; metric: BoundaryRankMetric; limit?: number }
  | { kind: "concepts"; metric: ConceptRankMetric; limit?: number };

export interface WorkspaceRankEntry {
  denominator?: number;
  id: string;
  kind: ProjectionEntityKind;
  label: string;
  numerator?: number;
  value: number;
}

export interface WorkspaceRankProjection {
  coverage: ProjectionCoverage;
  entries: WorkspaceRankEntry[];
  query: WorkspaceRankQuery;
  sort: "value desc, id asc";
  total: number;
}

// ---------------------------------------------------------------------------
// QUERIES

export interface WorkspaceQueryEntity {
  aliases?: string[];
  id: string;
  kind: ProjectionEntityKind;
  name: string;
  package?: string;
}

export type WorkspaceSearchMode = "exact" | "prefix" | "contains";

export interface WorkspaceSearchProjection {
  kinds: ProjectionEntityKind[] | null;
  matches: WorkspaceQueryEntity[];
  mode: WorkspaceSearchMode;
  text: string;
}

export type WorkspaceEntityResolution =
  | { status: "resolved"; entity: WorkspaceQueryEntity }
  | { status: "ambiguous"; candidates: WorkspaceQueryEntity[] }
  | { status: "not-found" };

export interface ConceptDirectionFilter {
  from?: string;
  minCount?: number;
  role?: ConceptDirectionRole;
  to?: string;
}

export interface WorkspaceDirectionListProjection {
  directions: ConceptDirectionProjection[];
  filter: ConceptDirectionFilter;
  sort: "count desc, id asc";
}

export interface ReviewListFilter {
  baselineDominated?: boolean;
  declaredPackage?: string;
  disposition?: ArchitecturalReviewDisposition;
  gravityCenter?: string;
}

export interface WorkspaceReviewListProjection {
  filter: ReviewListFilter;
  reviews: WorkspaceReviewProjection[];
  sort: "conceptId asc";
}

export type WorkspaceQuery =
  | { kind: "overview" }
  | { kind: "package"; id: string; detail?: ProjectionDetail }
  | { kind: "concept"; id: string; detail?: ProjectionDetail }
  | { kind: "boundary"; id: string; detail?: ProjectionDetail }
  | { kind: "pattern"; id: string; detail?: ProjectionDetail }
  | { kind: "review"; conceptId: string }
  | {
      kind: "graph";
      preset: WorkspaceGraphPreset;
      filter?: WorkspaceGraphFilter;
    }
  | { kind: "concept-graph"; conceptId: string }
  | { kind: "matrix"; metric: WorkspaceMatrixMetric }
  | { kind: "rank"; rank: WorkspaceRankQuery }
  | { kind: "directions"; filter?: ConceptDirectionFilter }
  | { kind: "reviews"; filter?: ReviewListFilter }
  | {
      kind: "search";
      text: string;
      mode?: WorkspaceSearchMode;
      kinds?: ProjectionEntityKind[];
    };

export type WorkspaceQueryResult =
  | { kind: "overview"; result: WorkspaceOverviewProjection }
  | { kind: "package"; result: WorkspacePackageProjection }
  | { kind: "package-summary"; result: WorkspacePackageSummaryProjection }
  | { kind: "concept"; result: WorkspaceConceptProjection }
  | { kind: "concept-summary"; result: WorkspaceConceptSummaryProjection }
  | { kind: "boundary"; result: WorkspaceBoundaryProjection }
  | { kind: "pattern"; result: WorkspacePatternProjection }
  | { kind: "review"; result: WorkspaceReviewProjection }
  | { kind: "graph"; result: WorkspaceGraphProjection }
  | { kind: "concept-graph"; result: WorkspaceConceptGraphProjection }
  | { kind: "matrix"; result: WorkspaceMatrixProjection }
  | { kind: "rank"; result: WorkspaceRankProjection }
  | { kind: "directions"; result: WorkspaceDirectionListProjection }
  | { kind: "reviews"; result: WorkspaceReviewListProjection }
  | { kind: "search"; result: WorkspaceSearchProjection }
  | {
      kind: "ambiguous";
      query: WorkspaceQuery;
      candidates: WorkspaceQueryEntity[];
    }
  | { kind: "not-found"; query: WorkspaceQuery };

export interface WorkspaceProjectionManifest {
  availableScopes: WorkspaceProjectionScope[];
  matrices: WorkspaceMatrixKind[];
  presets: WorkspaceGraphPreset[];
  projectionSchemaVersion: number;
  queryCapabilities: WorkspaceQuery["kind"][];
  workspaceSchemaVersion: number;
}
