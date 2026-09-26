import type { FileKind, ModuleRole } from "./types";

// V13.0 internal package topology: the module graph inside one package,
// derived from its `PackageLocalReport` alone. Descriptive facts only — no
// score, no recommendation. Versioned apart from the local report because
// the two evolve at different rates.

export const INTERNAL_PACKAGE_TOPOLOGY_SCHEMA_VERSION = 2;

/** Package-relative posix path of the module; the package root directory is `"."`. */
export type InternalModuleId = string;

export type InternalEdgeLocality =
  | "same-directory"
  | "same-region"
  | "cross-region";

export interface InternalEdgeSymbol {
  bindingOccurrences: number;
  /** Package-relative module declaring the symbol, when resolved. */
  declarationModule?: string;
  /** Sites naming the symbol directly; a namespace member access is not one. */
  importSites: number;
  /** True when the declaring module is not the edge target (a re-export chain sits between). */
  mediated: boolean;
  /** Name as imported at the edge target (`default` for a default import). */
  name: string;
  /** Namespace import sites reaching the symbol as `ns.name`. */
  namespaceSites: number;
  /** Sites that forward the symbol onward (`export … from`) rather than use it. */
  reExportSites: number;
  /** Canonical symbol id from the local report, when the name resolves to an owned declaration. */
  symbolId?: string;
  typeOnlySites: number;
}

/**
 * One directed dependency between two modules of the package, aggregating
 * every import and re-export site from `source` that resolved to `target`.
 */
export interface InternalModuleEdge {
  bindingOccurrences: number;
  /** Directory-tree distance between the owning directories (0 = same directory). */
  distance: number;
  importSites: number;
  locality: InternalEdgeLocality;
  namespaceSites: number;
  /** Both endpoints are `source`-kind files; only primary edges feed graph metrics. */
  primary: boolean;
  reExportSites: number;
  sideEffectSites: number;
  source: InternalModuleId;
  /** Named symbols the source asks the target for, sorted by name. */
  symbols: InternalEdgeSymbol[];
  target: InternalModuleId;
  typeOnlySites: number;
  valueSites: number;
}

export interface InternalModuleNode {
  /** Distinct named symbols this module consumes from other primary modules. */
  consumedSymbols: number;
  /** Distinct non-primary internal modules (tests, stories, config) importing this one. */
  contextFanIn: number;
  /** Cycle id when the module belongs to a strongly connected component of size > 1. */
  cycle?: string;
  declaredSymbols: number;
  /** Owning directory id. */
  directory: string;
  exportedSymbols: number;
  /** Distinct external specifiers imported. */
  externalFanOut: number;
  /** Distinct primary modules depending on this one. */
  fanIn: number;
  /** Distinct primary modules this one depends on. */
  fanOut: number;
  fileKind: FileKind;
  id: InternalModuleId;
  incomingImportSites: number;
  /** Longest primary dependency chain to a sink, on the SCC condensation. Primary modules only. */
  layer?: number;
  outgoingImportSites: number;
  primary: boolean;
  /** Distinct own declarations other primary modules consume, directly or through re-exports. */
  providedSymbols: number;
  /** Top-level path region after technical-root stripping. */
  region: string;
  /** Distinct primary modules consuming those declarations. */
  symbolConsumers: number;
  syntacticRole: ModuleRole;
}

export interface InternalDirectoryNode {
  childDirectories: string[];
  depth: number;
  descendantModules: number;
  directModules: InternalModuleId[];
  id: string;
  incomingEdges: number;
  /** Primary edges with both endpoints among descendants. */
  internalEdges: number;
  outgoingEdges: number;
  parent?: string;
  region: string;
}

/** Primary edges aggregated by owning directory pair (distinct directories only). */
export interface InternalDirectoryEdge {
  from: string;
  importSites: number;
  moduleEdges: number;
  sourceModules: number;
  /** Distinct symbol names crossing. */
  symbols: number;
  targetModules: number;
  to: string;
}

export interface InternalRegionNode {
  directories: number;
  id: string;
  /** Primary modules with at least one inbound cross-region edge. */
  inboundModules: number;
  incomingEdges: number;
  internalEdges: number;
  modules: number;
  /** Primary modules with at least one outbound cross-region edge. */
  outboundModules: number;
  outgoingEdges: number;
  primaryModules: number;
}

export interface InternalSeamParticipant {
  module: InternalModuleId;
  moduleEdges: number;
  share: number;
}

export interface InternalSeamSymbol {
  importSites: number;
  name: string;
  share: number;
}

/** Primary edges aggregated by ordered path-region pair (distinct regions only). */
export interface InternalSeam {
  /** Share of module edges whose target is a syntactic aggregator. */
  aggregatorTargetShare: number;
  bindingOccurrences: number;
  from: string;
  importSites: number;
  moduleEdges: number;
  sourceModules: InternalModuleId[];
  /** Share of the source region's primary modules on this seam. */
  sourceParticipation: number;
  /** Distinct symbol names crossing. */
  symbolFlow: number;
  targetModules: InternalModuleId[];
  targetParticipation: number;
  to: string;
  topSource: InternalSeamParticipant;
  topSymbol?: InternalSeamSymbol;
  topTarget: InternalSeamParticipant;
}

export type InternalCycleScope = "directory" | "region" | "cross-region";

export interface InternalCycle {
  directories: string[];
  /** Primary edges from modules outside the component into it. */
  entryEdges: number;
  exitEdges: number;
  id: string;
  importSites: number;
  internalEdges: number;
  modules: InternalModuleId[];
  regions: string[];
  scope: InternalCycleScope;
  /** Distinct symbol names on the cycle's internal edges. */
  symbolFlow: number;
  /** Most-imported symbols on internal edges, by import sites. */
  topSymbols: InternalSeamSymbol[];
}

export interface InternalLayer {
  index: number;
  modules: InternalModuleId[];
}

export type InternalModuleRole =
  | "dependency-source"
  | "dependency-sink"
  | "isolated"
  | "high-fan-in"
  | "high-fan-out"
  | "aggregator"
  | "bridge"
  | "satellite"
  | "cycle-member";

export interface InternalModuleRoleAssignment {
  module: InternalModuleId;
  roles: InternalModuleRole[];
}

export interface InternalSymbolConsumer {
  bindingOccurrences: number;
  importSites: number;
  module: InternalModuleId;
  namespaceSites: number;
  typeOnlySites: number;
  /** Module the consumer imported through when it is not the declaring module. */
  via?: InternalModuleId;
}

/** One owned declaration consumed by other primary modules of the package. */
export interface InternalConsumedSymbol {
  bindingOccurrences: number;
  consumerDirectories: string[];
  consumerModules: number;
  consumerRegions: string[];
  consumers: InternalSymbolConsumer[];
  declarationModule: InternalModuleId;
  declarationRegion: string;
  exported: boolean;
  importSites: number;
  /** Declared name; a default import resolves to it rather than to `default`. */
  name: string;
  namespaceSites: number;
  symbolId: string;
}

export interface InternalDistribution {
  max: number;
  median: number;
  min: number;
  p90: number;
}

export interface InternalTopologySummary {
  aggregators: number;
  bridges: number;
  /** Non-primary edges by the source module's file kind. */
  contextEdgesByKind: Record<FileKind, number>;
  crossRegionCycles: number;
  cycleMembers: number;
  cycles: number;
  dependencySinks: number;
  dependencySources: number;
  directories: number;
  distributions: {
    fanIn: InternalDistribution;
    fanOut: InternalDistribution;
    edgeSymbols: InternalDistribution;
    directoryModules: InternalDistribution;
    seamModuleEdges: InternalDistribution;
  };
  edges: number;
  /** Cutoffs the high-fan roles used for this package. */
  highFanCutoff: { fanIn: number; fanOut: number };
  highFanIn: number;
  highFanOut: number;
  isolated: number;
  largestCycle: number;
  layers: number;
  modules: number;
  modulesByKind: Record<FileKind, number>;
  primaryEdges: number;
  primaryModules: number;
  regions: number;
  satellites: number;
  seams: number;
  selfImports: number;
  /** Connected components of the undirected projection of the primary graph. */
  weakComponents: number;
}

/** The definitions the facts were computed under; static per schema version. */
export interface InternalTopologyPolicy {
  highFan: { percentile: number; minimum: number };
  layer: "longest primary dependency chain to a sink on the SCC condensation";
  primaryEdge: "both endpoints source-kind";
  structuralConnectivity: "undirected-projection";
  technicalRoots: string[];
}

export interface InternalPackageTopology {
  consumedSurface: InternalConsumedSymbol[];
  cycles: InternalCycle[];
  directories: InternalDirectoryNode[];
  directoryEdges: InternalDirectoryEdge[];
  edges: InternalModuleEdge[];
  layers: InternalLayer[];
  modules: InternalModuleNode[];
  package: {
    /** Package name, or its repository-relative path when unnamed. */
    id: string;
    /** Repository-relative posix path. */
    root: string;
  };
  policy: InternalTopologyPolicy;
  regions: InternalRegionNode[];
  roles: InternalModuleRoleAssignment[];
  schemaVersion: typeof INTERNAL_PACKAGE_TOPOLOGY_SCHEMA_VERSION;
  seams: InternalSeam[];
  /** Modules with an import site resolving to themselves. */
  selfImports: InternalModuleId[];
  summary: InternalTopologySummary;
}
