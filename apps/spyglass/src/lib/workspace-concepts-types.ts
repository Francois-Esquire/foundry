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

/**
 * V9.2 workspace concept intelligence: every canonical concept placed onto
 * the V9.1 workspace graph with explicit package roles, static paths,
 * layer span, boundary participation, related concepts, and history, then
 * aggregated into package-role, package-direction, and boundary-concept
 * views. Facts and recurrence only: no repository-wide role, cluster,
 * or pattern is inferred, and nothing is scored.
 */

/**
 * `authoritative`: the declaring package's report was ingested with
 * ownership and locality. `partial`: a seed report without one of them.
 * `foreign-only`: known only as an overlap partner; no centers, roles, or
 * shapes are available.
 */
export type WorkspaceConceptCoverage =
  | "authoritative"
  | "partial"
  | "foreign-only";

/** A package's role in a concept. `declares` is a fact, not ownership. */
export type WorkspaceConceptPackageRole =
  | "declares"
  | "implements"
  | "represents"
  | "uses"
  | "behaves"
  | "converts";

/** Where a concept appears, by role. Every list is sorted and may overlap the others. */
export interface WorkspaceConceptPresence {
  /**
   * Packages whose source behavior implements or converts the concept.
   * Behavior that only names the concept in a signature (parameter and
   * return consumers) is listed under `contractBehaviorPackages` and is
   * not a role, so incidental consumers never read as behavioral flow.
   */
  behaviorPackages: string[];
  contractBehaviorPackages: string[];
  converterPackages: string[];
  declaredPackage: string;
  /** Packages holding an `implements` representation. */
  implementationPackages: string[];
  /** Every package holding the declaration or any role, plus V7.0 evidence packages. */
  packages: string[];
  referencePackages: string[];
  representationPackages: string[];
  roles: { package: string; roles: WorkspaceConceptPackageRole[] }[];
}

/** Canonical counts; nothing is summed across observations. */
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

/** V7.3 centers, unchanged, with the graph position of each. */
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

/**
 * Static relation of a package to the concept's declared package.
 * `direct`/`indirect`: the package imports the declared package in one /
 * several hops. `reverse-directed`: only the declared package reaches it.
 * `disconnected`: neither reaches the other. `unmeasured`: not a graph node.
 */
type WorkspaceConceptPathRelation =
  | "direct"
  | "indirect"
  | "reverse-directed"
  | "disconnected"
  | "unmeasured";

export interface WorkspaceConceptPath {
  /** Edges along the relation's direction; null when disconnected or unmeasured. */
  distance: number | null;
  package: string;
  relation: WorkspaceConceptPathRelation;
  /** A V9.1 usage-only edge joins the two packages (either direction). */
  usageOnly: boolean;
}

/** The role the importing side of a package edge plays in the concept. */
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

/**
 * A package edge both of whose endpoints take part in the concept. Roles
 * are what `from` does with the concept; the edge is never claimed to be
 * about this concept alone.
 */
export interface WorkspaceConceptEdge {
  evidence: WorkspaceConceptEvidence[];
  from: string;
  fromDeclared: boolean;
  id: string;
  roles: ConceptEdgeRole[];
  /** Raw V9.1 structure; `seam` is the V9.1 label, context only. */
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
  /** Participating packages with no static path to or from the declared package. */
  disconnectedPackages: string[];
  edges: WorkspaceConceptEdge[];
  /** V9.1 longest package chains holding at least two participating packages. */
  longestChains: string[][];
  packageLayers: { package: string; layer: number | null }[];
  /** Presence packages that are V9.1 graph nodes. */
  participatingPackages: string[];
  /** Every other participating package relative to the declared package. */
  paths: WorkspaceConceptPath[];
  /** Presence packages absent from the graph (never analyzed, never an edge endpoint). */
  unknownPackages: string[];
  /** V9.1 usage-only edges joining two participating packages; flow context, not structure. */
  usageOnlyEdges: string[];
}

/**
 * Layer spans are max − min layer over the declared package plus the role's
 * packages; null when none of them is a graph node. `responsibilityLayerSpan`
 * covers behavior and implementation together. Representation is kept
 * apart because V7.0 representations include type users, so it tracks usage
 * and would let broad consumption dominate.
 */
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

/** Static paths from each role package to the declared package. */
export interface WorkspaceConceptFlow {
  semanticToBehavior: WorkspaceConceptPath[];
  semanticToConversions: WorkspaceConceptPath[];
  semanticToImplementations: WorkspaceConceptPath[];
  semanticToRepresentations: WorkspaceConceptPath[];
  semanticToUsage: WorkspaceConceptPath[];
}

/**
 * Where connected role packages sit relative to the declared package's
 * layer: `upstream` all above, `downstream` all below, `bidirectional`
 * both, `same-layer` none elsewhere, `disconnected` role packages exist but
 * none is connected, `unmeasured` when the declared package is not a node.
 */
export type WorkspaceConceptPropagation =
  | "upstream"
  | "downstream"
  | "bidirectional"
  | "same-layer"
  | "disconnected"
  | "unmeasured";

/** Descriptive shapes; several may apply. No quality reading. */
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
  /** Edge id with the most severed pairs; only when > 0. */
  highestSeverance?: string;
  /** Edge id with the most import sites (module edges when unknown). */
  highestVolume?: string;
  implementationBoundaries: number;
  seams: string[];
}

interface WorkspaceConceptConversion {
  /** `outgoing`: this concept converts to the other; `incoming`: the other converts to this. */
  direction: "outgoing" | "incoming";
  file: string;
  function: string;
  package: string | null;
}

/** One overlap partner as seen from this concept; full pair topology is in the index. */
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
  /** Overlaps carrying conversion evidence. */
  conversions: WorkspaceConceptRelationship[];
  overlaps: WorkspaceConceptRelationship[];
}

export interface WorkspaceConceptCoupling {
  coChangeCommits: number;
  context: CouplingContext;
  /** Package-level path on the V9.1 graph; `forward` is leftPackage → rightPackage. */
  dependencyPath: { forward: number | null; reverse: number | null };
  id: string;
  jaccard: number;
  left: string;
  leftPackage: string;
  right: string;
  rightPackage: string;
  scope: "same-package" | "cross-package";
  /** Module-level path as V6.2 measured it. */
  staticPath: StaticPathRelation;
}

export interface WorkspaceConceptEvolutionContext {
  /** Test, story, and mixed member pairs; context only. */
  contextualCouplings: WorkspaceConceptCoupling[];
  crossPackageCouplings: number;
  historicallyActivePackages: string[];
  hotspotPackages: string[];
  /** Source-source member pairs: the architectural history. */
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

/** One canonical concept placed on the workspace graph. */
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

/** Concept counts per role for one package; centers are V7.3 centers. */
export interface WorkspacePackageConceptRoleSummary {
  analyzed: boolean;
  /** Role count minus declared count; raw, unscored. */
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
  /** Distinct concepts participating here, by role (§48 matrix row). */
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

/**
 * Conceptual responsibility direction from the declaring package to a role
 * package. `dependencyPath` is the static direction, kept apart: an
 * implementation typically imports its contract, so `reverse` is set while
 * the direction runs the other way.
 */
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

/** A concept with `implements` representations, as a package-level family. */
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

/** Graph position of one canonical overlap pair; orientation follows the pair id. */
export interface WorkspaceConceptPairTopology {
  bidirectionalConversion: boolean;
  converterPackages: string[];
  /** Strong V6.2 pair between the two declaration files, when canonical. */
  coupling?: {
    coChangeCommits: number;
    context: CouplingContext;
    staticPath: StaticPathRelation;
  };
  /** `left→right` or `right→left` package edge id, when one exists. */
  directEdge: string | null;
  left: string;
  leftPackage: string;
  pair: string;
  /** Package-level path; `forward` is leftPackage → rightPackage. */
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

/** Histograms behind the shape thresholds, for tuning against the whole sweep. */
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
  /** Every V9.1 seam with its concept load, including seams carrying none. */
  seams: WorkspaceBoundaryConceptLoad[];
  summary: WorkspaceConceptSummary;
}
