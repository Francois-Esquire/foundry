import type { FileKind, ModuleRole } from "./types";

export const INTERNAL_PACKAGE_TOPOLOGY_SCHEMA_VERSION = 2;

type InternalModuleId = string;

export type InternalEdgeLocality =
  | "same-directory"
  | "same-region"
  | "cross-region";

export interface InternalEdgeSymbol {
  bindingOccurrences: number;
  declarationModule?: string;
  importSites: number;
  mediated: boolean;
  name: string;
  namespaceSites: number;
  reExportSites: number;
  symbolId?: string;
  typeOnlySites: number;
}

export interface InternalModuleEdge {
  bindingOccurrences: number;
  distance: number;
  importSites: number;
  locality: InternalEdgeLocality;
  namespaceSites: number;
  primary: boolean;
  reExportSites: number;
  sideEffectSites: number;
  source: InternalModuleId;
  symbols: InternalEdgeSymbol[];
  target: InternalModuleId;
  typeOnlySites: number;
  valueSites: number;
}

export interface InternalModuleNode {
  consumedSymbols: number;
  contextFanIn: number;
  cycle?: string;
  declaredSymbols: number;
  directory: string;
  exportedSymbols: number;
  externalFanOut: number;
  fanIn: number;
  fanOut: number;
  fileKind: FileKind;
  id: InternalModuleId;
  incomingImportSites: number;
  layer?: number;
  outgoingImportSites: number;
  primary: boolean;
  providedSymbols: number;
  region: string;
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
  internalEdges: number;
  outgoingEdges: number;
  parent?: string;
  region: string;
}

export interface InternalDirectoryEdge {
  from: string;
  importSites: number;
  moduleEdges: number;
  sourceModules: number;
  symbols: number;
  targetModules: number;
  to: string;
}

export interface InternalRegionNode {
  directories: number;
  id: string;
  inboundModules: number;
  incomingEdges: number;
  internalEdges: number;
  modules: number;
  outboundModules: number;
  outgoingEdges: number;
  primaryModules: number;
}

interface InternalSeamParticipant {
  module: InternalModuleId;
  moduleEdges: number;
  share: number;
}

export interface InternalSeamSymbol {
  importSites: number;
  name: string;
  share: number;
}

export interface InternalSeam {
  aggregatorTargetShare: number;
  bindingOccurrences: number;
  from: string;
  importSites: number;
  moduleEdges: number;
  sourceModules: InternalModuleId[];
  sourceParticipation: number;
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
  entryEdges: number;
  exitEdges: number;
  id: string;
  importSites: number;
  internalEdges: number;
  modules: InternalModuleId[];
  regions: string[];
  scope: InternalCycleScope;
  symbolFlow: number;
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
  via?: InternalModuleId;
}

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
  weakComponents: number;
}

interface InternalTopologyPolicy {
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
    id: string;
    root: string;
  };
  policy: InternalTopologyPolicy;
  regions: InternalRegionNode[];
  roles: InternalModuleRoleAssignment[];
  schemaVersion: typeof INTERNAL_PACKAGE_TOPOLOGY_SCHEMA_VERSION;
  seams: InternalSeam[];
  selfImports: InternalModuleId[];
  summary: InternalTopologySummary;
}
