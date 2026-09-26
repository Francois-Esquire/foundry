import type { InternalModuleRole } from "./internal-topology-types";
import type { ConceptRelationshipKind, SymbolKind } from "./types";

// V13.2 internal responsibility regions: coherent module neighborhoods
// inside one package, inferred from the local report, the internal
// topology, and symbol locality by a small set of explicit join rules.
// Path regions are priors, not answers; every region carries the evidence
// that built it. No score, no move target, no recommendation. Versioned
// apart from its inputs because the inference evolves at its own rate.

export const INTERNAL_RESPONSIBILITY_SCHEMA_VERSION = 1;

export type ResponsibilityEvidenceKind =
  | "path"
  | "dependency"
  | "cycle"
  | "concept"
  | "behavior"
  | "symbol-flow"
  | "seam";

/**
 * Why two units were joined. `concept-flow`: a direct edge carries a
 * localized concept seed between them. `directory-dependency`: a direct
 * edge carries a localized symbol and both endpoints share a directory
 * below the root. `directory-fallback`: single modules nothing else claimed,
 * grouped by their shared directory below the root.
 */
export type ResponsibilityJoinReason =
  | "concept-flow"
  | "directory-dependency"
  | "directory-fallback";

/** An atomic structural unit: a nontrivial cycle or one primary module outside any cycle. */
export interface ResponsibilityUnit {
  cycle?: string;
  id: string;
  kind: "cycle" | "module";
  modules: string[];
}

export interface ResponsibilityJoin {
  left: string;
  reasons: ResponsibilityJoinReason[];
  right: string;
  /** Localized symbols carried by the joining edges, sorted. */
  symbols: string[];
}

export type ResponsibilityPathAgreement =
  /** The region is exactly one path region's primary modules. */
  | "matches-path-region"
  /** The region sits inside one path region beside other responsibilities. */
  | "within-path-region"
  | "spans-path-regions";

export type ResponsibilityLabelBasis = "directory" | "concept" | "module";

export interface ResponsibilityConceptEntry {
  conceptId: string;
  /** Region modules participating (declaring module excluded). */
  modules: number;
  name: string;
  /** Relationship kinds present, sorted. */
  relationships: ConceptRelationshipKind[];
}

export interface ResponsibilityRegion {
  /** Connector modules attached after construction: aggregators and high-fan modules whose neighbors all sit here. */
  attached: string[];
  behavior: {
    /** Source behavior mass: executable statements measured across the region's functions. */
    mass: number;
    bearingModules: number;
    dominantModules: { module: string; statements: number; share: number }[];
    /** Mass owned by concept-seed declarations. */
    conceptOwnedMass: number;
    /** Seeds owning measured functions in the region, sorted. */
    conceptOwners: string[];
  };
  concepts: {
    /** Seeds declared in the region, by region participants descending then id. */
    declared: ResponsibilityConceptEntry[];
    /** Localized seeds declared elsewhere that region modules participate in, same order; broad seeds are package vocabulary and are not listed per region. */
    referenced: ResponsibilityConceptEntry[];
  };
  construction: {
    joins: ResponsibilityJoin[];
    joinsByReason: Record<ResponsibilityJoinReason, number>;
  };
  /** Evidence kinds present; the complement is what the region lacks. */
  evidence: ResponsibilityEvidenceKind[];
  /** `responsibility:<hash>` over the sorted member modules. */
  id: string;
  label: string;
  labelBasis: ResponsibilityLabelBasis;
  /** Sorted primary modules, attached connectors included. */
  modules: string[];
  path: {
    directories: string[];
    pathRegions: string[];
    dominantDirectory: { id: string; modules: number; share: number };
    agreement: ResponsibilityPathAgreement;
  };
  symbols: {
    /** Internally consumed symbols declared in the region. */
    declared: number;
    /** …whose every consumer is also in the region. */
    local: number;
    /** …with a consumer outside the region. */
    crossing: number;
    /** Symbols declared outside consumed by region modules. */
    consumedFromOutside: number;
    /** Package-distributed symbols consumed by region modules. */
    distributedConsumed: number;
    /** Locality findings declared here whose behavior-heaviest region is not the module-heaviest one. */
    behaviorDisagreesWithUsage: number;
  };
  topology: {
    internalEdges: number;
    inboundEdges: number;
    outboundEdges: number;
    cycles: string[];
    layerSpan: { min: number; max: number };
    dependencySources: number;
    dependencySinks: number;
    roles: Partial<Record<InternalModuleRole, number>>;
  };
  units: string[];
}

/** Primary edges aggregated by ordered responsibility pair; both endpoints assigned. */
export interface ResponsibilityRelationship {
  /** Crossing symbols that are concept seeds, sorted. */
  concepts: string[];
  /** Most-imported crossing symbols. */
  dominantSymbols: { name: string; symbolId?: string; importSites: number }[];
  from: string;
  importSites: number;
  /** Module edges whose every symbol arrived through a re-export chain. */
  mediatedEdges: number;
  moduleEdges: number;
  /** Module edges inside one path region versus across path regions. */
  pathRegions: { within: number; across: number };
  sourceModules: string[];
  /** Distinct symbols crossing. */
  symbolFlow: number;
  targetModules: string[];
  to: string;
}

export type ResponsibilityAmbiguityReason =
  /** Syntactic aggregator forwarding into several responsibilities. */
  | "aggregator"
  /** High-fan-in module: its symbols are consumed across responsibilities. */
  | "distributed-primitive"
  /** High-fan-out module drawing localized symbols from several responsibilities. */
  | "wide-dependent"
  /** Articulation point with localized neighbors in several responsibilities. */
  | "bridge";

export interface ResponsibilityCandidate {
  /** Module edges to the candidate. */
  edges: number;
  /** Localized symbols on those edges. */
  localizedSymbols: number;
  region: string;
}

export interface ResponsibilityAmbiguity {
  /** By edges descending, then localized symbols, then id. */
  candidates: ResponsibilityCandidate[];
  module: string;
  reason: ResponsibilityAmbiguityReason;
  roles: InternalModuleRole[];
}

export type ResponsibilityModuleStatus = "assigned" | "attached" | "unresolved";

export interface ResponsibilityAffinity {
  edges: number;
  kinds: ("dependency" | "concept")[];
  region: string;
}

export interface ResponsibilityModuleEvidence {
  /** Other regions reached by localized-symbol edges, by edges descending. */
  affinities: ResponsibilityAffinity[];
  behaviorMass: number;
  concepts: { declared: number; participating: number };
  /** Excluded from join evidence: aggregator or high-fan role. */
  connector: boolean;
  cycle?: string;
  directory: string;
  localizedSymbols: { declared: number; consumed: number };
  module: string;
  /** Whether the module's directory is that of its region's dominant directory. */
  pathAgreesWithRegion?: boolean;
  pathRegion: string;
  region?: string;
  roles: InternalModuleRole[];
  status: ResponsibilityModuleStatus;
  unit: string;
}

export type ResponsibilitySymbolLocality =
  | "responsibility-local"
  | "responsibility-crossing"
  /** Declaring module or every consumer unresolved. */
  | "unplaced";

/** V13.1 finding joined to responsibility context; the finding itself is untouched. */
export interface ResponsibilitySymbolContext {
  conceptSeed: boolean;
  consumerModules: number;
  /** Distinct consumer responsibilities, sorted. */
  consumerRegions: string[];
  declarationRegion?: string;
  kind: SymbolKind;
  locality: ResponsibilitySymbolLocality;
  name: string;
  symbolId: string;
  unresolvedConsumers: number;
}

export interface ResponsibilityPathSeamComparison {
  acrossResponsibilities: number;
  from: string;
  moduleEdges: number;
  to: string;
  /** Edges touching an unresolved module. */
  unresolved: number;
  /** Edges whose endpoints share a responsibility. */
  withinResponsibility: number;
}

export interface InternalResponsibilitySummary {
  assignedModules: number;
  attachedModules: number;
  behaviorBearingRegions: number;
  behaviorLightRegions: number;
  /** Behavior mass over assigned modules, and the share held by the heaviest region. */
  behaviorMass: { total: number; topRegionShare: number };
  byLabelBasis: Record<ResponsibilityLabelBasis, number>;
  byPathAgreement: Record<ResponsibilityPathAgreement, number>;
  connectors: number;
  cycleUnits: number;
  joinsByReason: Record<ResponsibilityJoinReason, number>;
  largestRegion: number;
  multiModuleRegions: number;
  /** Path regions whose assigned modules land in more than one responsibility. */
  pathRegionsSplit: number;
  /** Path seams whose every resolved module edge stays inside one responsibility. */
  pathSeamsCollapsed: number;
  primaryModules: number;
  /** Cycles among responsibilities. */
  regionCycles: number;
  regions: number;
  regionsWithDeclaredConcepts: number;
  regionsWithoutConcepts: number;
  regionsWithSeveralConcepts: number;
  relationships: number;
  /** Responsibility relationships whose every module edge stays inside one path region. */
  relationshipsHiddenInPathRegions: number;
  /** Responsibilities spanning more than one directory. */
  responsibilitiesSpanningDirectories: number;
  /** Responsibilities spanning more than one path region. */
  responsibilitiesSpanningPaths: number;
  singleModuleRegions: number;
  symbols: Record<ResponsibilitySymbolLocality, number>;
  units: number;
  unresolvedByReason: Record<ResponsibilityAmbiguityReason, number>;
  unresolvedModules: number;
}

/** The definitions the regions were computed under. */
export interface InternalResponsibilityPolicy {
  attachment: "a connector joins the one region its localized-symbol edges reach, else the one region any edge reaches; several regions leave it unresolved";
  bridge: "a bridge-role module with no join and localized-symbol edges into several regions is unresolved";
  connectorRoles: InternalModuleRole[];
  identity: "sha256 over the sorted member modules";
  joins: Record<ResponsibilityJoinReason, string>;
  label: "the shared directory below the root; else the declared concept with the most region participants; else the highest fan-in module";
  localizedSymbol: "a consumed symbol below the cutoff whose locality is neither package-distributed nor split";
  /** Consumer-module count at which a symbol stops counting as localized; the topology's high-fan-in cutoff. */
  localizedSymbolCutoff: number;
  order: "modules descending, then first module";
  technicalRoots: string[];
  unit: "nontrivial cycle, else one primary module";
}

export interface InternalResponsibilityReport {
  /** Evidence not available here, so no region can claim it. */
  limitations: string[];
  modules: ResponsibilityModuleEvidence[];
  package: { id: string; root: string };
  pathSeams: ResponsibilityPathSeamComparison[];
  policy: InternalResponsibilityPolicy;
  /** Strongly connected responsibilities, each sorted; by size descending then first id. */
  regionCycles: string[][];
  regions: ResponsibilityRegion[];
  relationships: ResponsibilityRelationship[];
  schemaVersion: typeof INTERNAL_RESPONSIBILITY_SCHEMA_VERSION;
  summary: InternalResponsibilitySummary;
  symbols: ResponsibilitySymbolContext[];
  units: ResponsibilityUnit[];
  unresolved: ResponsibilityAmbiguity[];
}
