import type { ModuleRole } from "./types";

export type WorkspaceGraphCertainty = "complete" | "partial";

export interface WorkspaceComponent {
  id: string;
  nodes: string[];
  size: number;
}

export interface WorkspaceStrongComponent {
  id: string;
  nodes: string[];
  size: number;
}

interface WorkspaceTopology {
  articulationPackages: string[];
  connectedComponents: number;
  moduleConnectedComponents: number;
  moduleDensity: number | null;
  moduleEdges: number;
  moduleNodes: number;
  moduleSinks: string[];
  moduleSources: string[];
  packageComponents: WorkspaceComponent[];
  packageDensity: number | null;
  packageEdges: number;
  packageIsolated: string[];
  packageNodes: number;
  packageSinks: string[];
  packageSources: string[];
  usageOnlyEdges: string[];
}

export type WorkspacePackageGraphRole =
  | "source"
  | "sink"
  | "isolated"
  | "intermediate";

export interface WorkspaceNodeGraphFacts {
  component: string;
  cycle: boolean;
  depth: { upstream: number; downstream: number };
  direct: { fanIn: number; fanOut: number };
  layer: number;
  reach: { dependentShare: number; dependencyShare: number };
  strongComponent: string | null;
  transitive: { dependents: number; dependencies: number };
}

export interface WorkspacePackageGraphAnalysis extends WorkspaceNodeGraphFacts {
  analyzed: boolean;
  anchored: boolean;
  articulation: boolean;
  betweenness: number;
  package: string;
  role: WorkspacePackageGraphRole;
}

export interface WorkspaceModuleGraphAnalysis extends WorkspaceNodeGraphFacts {
  module: string;
  package?: string;
  role?: ModuleRole;
}

interface WorkspaceEdgeWeights {
  distinctSymbols: number | null;
  importSites: number | null;
  moduleEdges: number;
  references: number | null;
}

export interface WorkspacePackageGraphEdge {
  alternativeRoutes: number;
  betweenness: number;
  from: string;
  id: string;
  separates: { from: number; to: number } | null;
  severedPairs: number;
  to: string;
  verified: boolean;
  weakBridge: boolean;
  weights: WorkspaceEdgeWeights;
}

type WorkspaceGraphEvidenceKind =
  | "dependency-edge"
  | "boundary"
  | "reachability"
  | "shortest-path"
  | "component"
  | "cycle"
  | "anchor";

interface WorkspaceGraphEvidence {
  entities: string[];
  kind: WorkspaceGraphEvidenceKind;
  value?: number | string | boolean;
}

export interface WorkspaceSeam {
  alternativePaths: number | null;
  anchored: string[];
  boundary: string;
  bridgeStrength: number | null;
  downstreamPackages: number;
  evidence: WorkspaceGraphEvidence[];
  from: string;
  id: string;
  severedPairs: number;
  to: string;
  upstreamPackages: number;
  weakBridge: boolean;
}

export interface WorkspaceCorridor {
  destinationPackages: string[];
  evidence: WorkspaceGraphEvidence[];
  id: string;
  length: number;
  packages: string[];
  sourcePackages: string[];
  support: number;
}

export interface WorkspaceRankedNode {
  id: string;
  role?: ModuleRole;
  value: number;
}

export interface WorkspaceGraphCenters {
  bridgePackages: WorkspaceRankedNode[];
  highDependencyReachPackages: WorkspaceRankedNode[];
  highDependentReachPackages: WorkspaceRankedNode[];
  highFanInModules: WorkspaceRankedNode[];
  highFanInPackages: WorkspaceRankedNode[];
  highFanOutPackages: WorkspaceRankedNode[];
}

export interface WorkspaceLayer {
  index: number;
  nodes: string[];
}

export interface WorkspaceLayerAnalysis {
  maxModuleDepth: number;
  maxPackageDepth: number;
  moduleLayers: WorkspaceLayer[];
  packageLayers: WorkspaceLayer[];
}

interface WorkspaceCycleAnalysis {
  largestModuleCycle: number;
  moduleCycles: number;
  moduleStrongComponents: WorkspaceStrongComponent[];
  packageCycles: number;
  packageStrongComponents: WorkspaceStrongComponent[];
}

interface WorkspaceReachabilitySummary {
  longestModuleChains: string[][];
  longestPackageChains: string[][];
  modulePairsReachable: number;
  modulePairsUnreachable: number;
  packagePairsReachable: number;
  packagePairsUnreachable: number;
}

type WorkspaceGraphCautionKind =
  | "partial-coverage"
  | "module-graph-cross-package-only"
  | "usage-only-edges"
  | "corridor-enumeration-capped";

export interface WorkspaceGraphCaution {
  detail: string;
  entities: string[];
  kind: WorkspaceGraphCautionKind;
}

interface WorkspaceGraphSummary {
  components: number;
  corridors: number;
  cycles: number;
  maxModuleDepth: number;
  maxPackageDepth: number;
  packageEdges: number;
  packages: number;
  seams: number;
  sinks: number;
  sources: number;
}

export interface WorkspaceGraphAnalysis {
  cautions: WorkspaceGraphCaution[];
  centers: WorkspaceGraphCenters;
  certainty: WorkspaceGraphCertainty;
  corridors: WorkspaceCorridor[];
  cycles: WorkspaceCycleAnalysis;
  edges: WorkspacePackageGraphEdge[];
  layers: WorkspaceLayerAnalysis;
  modules: WorkspaceModuleGraphAnalysis[];
  packages: WorkspacePackageGraphAnalysis[];
  population: { packages: number; modules: number };
  reachability: WorkspaceReachabilitySummary;
  seams: WorkspaceSeam[];
  summary: WorkspaceGraphSummary;
  topology: WorkspaceTopology;
}
