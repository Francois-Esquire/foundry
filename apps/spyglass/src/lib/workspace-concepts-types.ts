import type {
  ArchitecturalReviewDisposition,
  BehavioralLocalityShape,
  ConceptOverlapShape,
  ConceptSeedKind,
  CouplingContext,
  OwnershipAlignment,
  RecenteringStatus,
  StaticPathRelation,
} from "./types";
import type { WorkspaceGraphCertainty } from "./workspace-graph-types";

export type WorkspaceConceptCoverage =
  | "authoritative"
  | "partial"
  | "foreign-only";

export type WorkspaceConceptPackageRole =
  | "declares"
  | "implements"
  | "represents"
  | "uses"
  | "behaves"
  | "converts";

export interface WorkspaceConceptPresence {
  behaviorPackages: string[];
  contractBehaviorPackages: string[];
  converterPackages: string[];
  declaredPackage: string;
  implementationPackages: string[];
  packages: string[];
  referencePackages: string[];
  representationPackages: string[];
  roles: { package: string; roles: WorkspaceConceptPackageRole[] }[];
}

export interface WorkspaceConceptExtent {
  behaviorPackages: number;
  converterPackages: number;
  implementationPackages: number;
  implementations: number | null;
  moduleCount: number | null;
  packageCount: number;
  referencePackages: number;
  references: number | null;
  representationPackages: number;
  representations: number | null;
}

export interface WorkspaceConceptCenters {
  behavior?: string;
  evolution?: string;
  graphContext: {
    semanticLayer?: number;
    representationLayer?: number;
    usageLayer?: number;
    behaviorLayer?: number;
    semanticReach?: { dependents: number; dependencies: number };
    representationReach?: { dependents: number; dependencies: number };
  };
  implementations: string[];
  representation?: string;
  semantic?: string;
  usage?: string;
}

type WorkspaceConceptPathRelation =
  | "direct"
  | "indirect"
  | "reverse-directed"
  | "disconnected"
  | "unmeasured";

export interface WorkspaceConceptPath {
  distance: number | null;
  package: string;
  relation: WorkspaceConceptPathRelation;
  usageOnly: boolean;
}

export type ConceptEdgeRole =
  | "semantic-use"
  | "behavior"
  | "implementation"
  | "representation"
  | "conversion";

interface WorkspaceConceptEvidence {
  entities: string[];
  kind:
    | "package-role"
    | "dependency-edge"
    | "boundary"
    | "shortest-path"
    | "component"
    | "conversion"
    | "coupling";
  value?: number | string | boolean;
}

export interface WorkspaceConceptEdge {
  evidence: WorkspaceConceptEvidence[];
  from: string;
  fromDeclared: boolean;
  id: string;
  roles: ConceptEdgeRole[];
  structure: {
    severedPairs: number;
    alternativeRoutes: number;
    weakBridge: boolean;
    seam: boolean;
  };
  to: string;
  toDeclared: boolean;
  volume: {
    moduleEdges: number;
    importSites: number | null;
    references: number | null;
    distinctSymbols: number | null;
  };
}

export interface WorkspaceConceptTopology {
  components: string[];
  disconnectedPackages: string[];
  edges: WorkspaceConceptEdge[];
  longestChains: string[][];
  packageLayers: { package: string; layer: number | null }[];
  participatingPackages: string[];
  paths: WorkspaceConceptPath[];
  unknownPackages: string[];
  usageOnlyEdges: string[];
}

export interface WorkspaceConceptSpan {
  behaviorBoundaryCount: number;
  behaviorLayerSpan: number | null;
  boundaryCount: number;
  disconnectedRegions: number;
  implementationBoundaryCount: number;
  implementationLayerSpan: number | null;
  layerSpan: number | null;
  layers: number;
  maxLayer: number | null;
  minLayer: number | null;
  packages: number;
  representationLayerSpan: number | null;
  responsibilityLayerSpan: number | null;
  usageLayerSpan: number | null;
}

export interface WorkspaceConceptFlow {
  semanticToBehavior: WorkspaceConceptPath[];
  semanticToConversions: WorkspaceConceptPath[];
  semanticToImplementations: WorkspaceConceptPath[];
  semanticToRepresentations: WorkspaceConceptPath[];
  semanticToUsage: WorkspaceConceptPath[];
}

export type WorkspaceConceptPropagation =
  | "upstream"
  | "downstream"
  | "bidirectional"
  | "same-layer"
  | "disconnected"
  | "unmeasured";

export type WorkspaceConceptShape =
  | "local"
  | "downstream-implemented"
  | "upstream-consumed"
  | "cross-layer"
  | "parallel-implementation"
  | "representation-split"
  | "multi-region";

interface WorkspaceConceptBoundaryContext {
  behaviorBoundaries: number;
  count: number;
  highestSeverance?: string;
  highestVolume?: string;
  implementationBoundaries: number;
  seams: string[];
}

interface WorkspaceConceptConversion {
  direction: "outgoing" | "incoming";
  file: string;
  function: string;
  package: string | null;
}

export interface WorkspaceConceptRelationship {
  bidirectionalConversion: boolean;
  conversions: WorkspaceConceptConversion[];
  crossPackage: boolean;
  other: string;
  otherPackage: string;
  pair: string;
  shapes: ConceptOverlapShape[];
}

interface WorkspaceConceptRelationshipContext {
  conversions: WorkspaceConceptRelationship[];
  overlaps: WorkspaceConceptRelationship[];
}

export interface WorkspaceConceptCoupling {
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

export interface WorkspaceConceptEvolutionContext {
  contextualCouplings: WorkspaceConceptCoupling[];
  crossPackageCouplings: number;
  historicallyActivePackages: string[];
  hotspotPackages: string[];
  strongMemberCouplings: WorkspaceConceptCoupling[];
}

interface WorkspaceConceptArchitectureContext {
  anchored: boolean;
  localityShape?: BehavioralLocalityShape;
  ownershipAlignment?: OwnershipAlignment;
  recenteringFinding?: string;
  recenteringStatus?: RecenteringStatus;
  reviewDisposition?: ArchitecturalReviewDisposition;
}

type WorkspaceConceptCautionKind =
  | "foreign-only"
  | "partial-analysis"
  | "partial-graph-coverage"
  | "package-not-in-graph"
  | "usage-only-flow"
  | "no-implementation-evidence";

export interface WorkspaceConceptCaution {
  detail: string;
  entities: string[];
  kind: WorkspaceConceptCautionKind;
}

export interface WorkspaceConceptPlacement {
  architecture?: WorkspaceConceptArchitectureContext;
  boundaries: WorkspaceConceptBoundaryContext;
  cautions: WorkspaceConceptCaution[];
  centers?: WorkspaceConceptCenters;
  concept: {
    id: string;
    name: string;
    kind: ConceptSeedKind;
    package: string;
    file: string;
  };
  coverage: WorkspaceConceptCoverage;
  evolution?: WorkspaceConceptEvolutionContext;
  extent: WorkspaceConceptExtent;
  flow: WorkspaceConceptFlow;
  presence: WorkspaceConceptPresence;
  propagation: WorkspaceConceptPropagation;
  relationships: WorkspaceConceptRelationshipContext;
  shapes: WorkspaceConceptShape[];
  span: WorkspaceConceptSpan;
  topology: WorkspaceConceptTopology;
}

export interface WorkspacePackageConceptRoleSummary {
  analyzed: boolean;
  asymmetry: {
    implementingMinusDeclared: number;
    behavingMinusDeclared: number;
    representingMinusDeclared: number;
  };
  behaviorCenters: number;
  declaredConcepts: number;
  evolutionCenters: number;
  implementationCenters: number;
  package: string;
  participating: {
    total: number;
    implementing: number;
    behaving: number;
    representing: number;
    using: number;
    converting: number;
  };
  representationCenters: number;
  semanticCenters: number;
  usageCenters: number;
}

export type WorkspaceConceptDirectionKind =
  | "semantic-to-implementation"
  | "semantic-to-behavior"
  | "semantic-to-representation"
  | "semantic-to-usage"
  | "semantic-to-conversion";

export interface WorkspaceConceptDirection {
  concepts: string[];
  count: number;
  dependencyPath: {
    forward: number | null;
    reverse: number | null;
    usageOnly: boolean;
  };
  from: string;
  id: string;
  kind: WorkspaceConceptDirectionKind;
  to: string;
}

export interface WorkspaceBoundaryConceptLoad {
  boundaryId: string;
  conceptCount: number;
  concepts: string[];
  from: string;
  roles: {
    semanticUse: number;
    behavior: number;
    implementation: number;
    representation: number;
    conversion: number;
  };
  structure: WorkspaceConceptEdge["structure"];
  to: string;
  volume: WorkspaceConceptEdge["volume"];
}

export type WorkspaceContractFamilyCategory =
  | "single-package-contract"
  | "cross-package-implementation"
  | "parallel-implementation"
  | "downstream-implementation"
  | "disconnected-implementation";

export interface WorkspaceConceptFamilyTopology {
  boundaries: string[];
  categories: WorkspaceContractFamilyCategory[];
  concept: string;
  contractPackage: string;
  couplings: string[];
  implementationPackages: string[];
  layers: { package: string; layer: number | null }[];
  name: string;
  paths: WorkspaceConceptPath[];
}

export interface WorkspaceConceptPairTopology {
  bidirectionalConversion: boolean;
  converterPackages: string[];
  coupling?: {
    coChangeCommits: number;
    context: CouplingContext;
    staticPath: StaticPathRelation;
  };
  directEdge: string | null;
  left: string;
  leftPackage: string;
  pair: string;
  path: { forward: number | null; reverse: number | null };
  right: string;
  rightPackage: string;
  sameComponent: boolean | null;
  sameLayer: boolean | null;
  samePackage: boolean;
  shapes: ConceptOverlapShape[];
}

interface WorkspaceConceptRelationshipIndex {
  bidirectionalConversionPairs: number;
  conversionPairs: number;
  crossPackagePairs: number;
  overlapPairs: number;
  pairs: WorkspaceConceptPairTopology[];
}

export interface WorkspaceConceptSpanDistribution {
  boundaries: Record<string, number>;
  layerSpan: Record<string, number>;
  packages: Record<string, number>;
  responsibilityLayerSpan: Record<string, number>;
  usageLayerSpan: Record<string, number>;
}

interface WorkspaceConceptSummary {
  authoritative: number;
  conceptBearingBoundaries: number;
  concepts: number;
  conversionPairs: number;
  crossLayer: number;
  crossPackage: number;
  directions: number;
  downstreamImplemented: number;
  families: number;
  foreignOnly: number;
  local: number;
  multiRegion: number;
  overlapPairs: number;
  parallelImplementation: number;
  partial: number;
  representationSplit: number;
  upstreamConsumed: number;
}

type WorkspaceConceptIntelligenceCautionKind =
  | "partial-coverage"
  | "foreign-only-concepts"
  | "unknown-packages";

export interface WorkspaceConceptIntelligenceCaution {
  detail: string;
  entities: string[];
  kind: WorkspaceConceptIntelligenceCautionKind;
}

export interface WorkspaceConceptIntelligence {
  boundaries: WorkspaceBoundaryConceptLoad[];
  cautions: WorkspaceConceptIntelligenceCaution[];
  certainty: WorkspaceGraphCertainty;
  concepts: WorkspaceConceptPlacement[];
  directions: WorkspaceConceptDirection[];
  distributions: WorkspaceConceptSpanDistribution;
  families: WorkspaceConceptFamilyTopology[];
  packageRoles: WorkspacePackageConceptRoleSummary[];
  relationships: WorkspaceConceptRelationshipIndex;
  seams: WorkspaceBoundaryConceptLoad[];
  summary: WorkspaceConceptSummary;
}
