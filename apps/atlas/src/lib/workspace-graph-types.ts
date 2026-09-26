import type { ModuleRole } from "./types";

/**
 * V9.1 workspace graph intelligence: the canonical package and module graphs
 * of a `WorkspaceReport` analyzed as one system. Derived once from V9.0
 * facts; never merged from per-package gravity. Descriptive graph facts
 * only — no score, no semantic interpretation.
 */

export type WorkspaceGraphCertainty = "complete" | "partial";

/** Weakly connected component; `id` is its lexically smallest node. */
export interface WorkspaceComponent {
  id: string;
  nodes: string[];
  size: number;
}

/** Strongly connected component of size ≥ 2; `id` is its lexically smallest node. */
export interface WorkspaceStrongComponent {
  id: string;
  nodes: string[];
  size: number;
}

export interface WorkspaceTopology {
  /** Packages whose removal disconnects the weak package graph. */
  articulationPackages: string[];
  connectedComponents: number;
  moduleConnectedComponents: number;
  moduleDensity: number | null;
  moduleEdges: number;
  moduleNodes: number;
  moduleSinks: string[];
  moduleSources: string[];
  packageComponents: WorkspaceComponent[];
  /** edges / (n · (n − 1)); null below two nodes. Descriptive only. */
  packageDensity: number | null;
  packageEdges: number;
  packageIsolated: string[];
  packageNodes: number;
  packageSinks: string[];
  packageSources: string[];
  /**
   * Canonical dependency edges with no import module edges (the destination
   * saw usage through re-exports only). Not part of the package graph: the
   * module graph already carries that path through the re-exporting package.
   */
  usageOnlyEdges: string[];
}

export type WorkspacePackageGraphRole =
  | "source"
  | "sink"
  | "isolated"
  | "intermediate";

export interface WorkspaceNodeGraphFacts {
  /** Weak component id. */
  component: string;
  cycle: boolean;
  /**
   * Longest chain length in edges on the SCC condensation. `upstream` follows
   * dependency edges (how far this node's dependencies go); `downstream`
   * follows dependent edges.
   */
  depth: { upstream: number; downstream: number };
  direct: { fanIn: number; fanOut: number };
  /**
   * Sink-oriented layer: 0 = depends on nothing at this level; n = one more
   * than the deepest layer it depends on. Equals `depth.upstream`; cycle
   * members share their component's layer.
   */
  layer: number;
  /** Transitive counts over the other nodes at the same level (population − 1). */
  reach: { dependentShare: number; dependencyShare: number };
  /** SCC id when the node is in a cycle. */
  strongComponent: string | null;
  /** Unique nodes reachable through the graph, excluding the node; cycle-safe. */
  transitive: { dependents: number; dependencies: number };
}

export interface WorkspacePackageGraphAnalysis extends WorkspaceNodeGraphFacts {
  analyzed: boolean;
  anchored: boolean;
  articulation: boolean;
  /** Fraction of shortest paths between other packages passing through this one, over (n−1)(n−2) ordered pairs. */
  betweenness: number;
  package: string;
  role: WorkspacePackageGraphRole;
}

export interface WorkspaceModuleGraphAnalysis extends WorkspaceNodeGraphFacts {
  module: string;
  package?: string;
  /** Canonical V6 role when the module's own package was analyzed. */
  role?: ModuleRole;
}

/** Independent edge weights; never combined. Null when the boundary lacks the fact. */
export interface WorkspaceEdgeWeights {
  distinctSymbols: number | null;
  importSites: number | null;
  moduleEdges: number;
  references: number | null;
}

export interface WorkspacePackageGraphEdge {
  /** Other first hops out of `from` that still reach `to` without this edge. */
  alternativeRoutes: number;
  /** Fraction of shortest paths between all ordered package pairs using this edge, over n(n−1). */
  betweenness: number;
  from: string;
  /** `${from}→${to}`; equals the canonical dependency edge and boundary id. */
  id: string;
  /** Weak component sizes on each side after removal; null unless `weakBridge`. */
  separates: { from: number; to: number } | null;
  /** Ordered pairs other than (from, to) that stop being reachable without this edge. */
  severedPairs: number;
  to: string;
  verified: boolean;
  /** Removing the edge splits its weak component. */
  weakBridge: boolean;
  weights: WorkspaceEdgeWeights;
}

export type WorkspaceGraphEvidenceKind =
  | "dependency-edge"
  | "boundary"
  | "reachability"
  | "shortest-path"
  | "component"
  | "cycle"
  | "anchor";

export interface WorkspaceGraphEvidence {
  entities: string[];
  kind: WorkspaceGraphEvidenceKind;
  value?: number | string | boolean;
}

/**
 * A package edge that matters to workspace connectivity: it is the only
 * route for some dependency pair beyond its own endpoints, or it is a weak
 * bridge between regions of at least `minRegionSize` packages each.
 */
export interface WorkspaceSeam {
  /** First-hop alternatives from `from` that still reach `to`. */
  alternativePaths: number | null;
  /** Anchored endpoint packages; context only, never a criterion. */
  anchored: string[];
  boundary: string;
  /** Edge betweenness. */
  bridgeStrength: number | null;
  /** Packages reachable from `to`, plus `to`. */
  downstreamPackages: number;
  evidence: WorkspaceGraphEvidence[];
  from: string;
  id: string;
  severedPairs: number;
  to: string;
  /** Packages that reach `from`, plus `from`. */
  upstreamPackages: number;
  weakBridge: boolean;
}

/**
 * A path segment of ≥ `minLength` edges shared by the shortest dependency
 * routes of ≥ `minSupport` distinct package pairs, and not contained in a
 * longer segment that also qualifies. A pair whose whole route is the
 * segment counts.
 */
export interface WorkspaceCorridor {
  destinationPackages: string[];
  evidence: WorkspaceGraphEvidence[];
  /** Packages joined by `→`. */
  id: string;
  /** Edges. */
  length: number;
  packages: string[];
  sourcePackages: string[];
  /** Distinct (source, destination) pairs whose shortest routes use the segment. */
  support: number;
}

export interface WorkspaceRankedNode {
  id: string;
  role?: ModuleRole;
  value: number;
}

export interface WorkspaceGraphCenters {
  /** Ranked by node betweenness; empty when no package lies on another pair's shortest path. */
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

export interface WorkspaceCycleAnalysis {
  largestModuleCycle: number;
  moduleCycles: number;
  moduleStrongComponents: WorkspaceStrongComponent[];
  packageCycles: number;
  packageStrongComponents: WorkspaceStrongComponent[];
}

export interface WorkspaceReachabilitySummary {
  longestModuleChains: string[][];
  /**
   * Longest dependency paths on the condensation, source to sink, up to
   * `report.topChains`; a cycle appears as its sorted members in `[a|b]`.
   */
  longestPackageChains: string[][];
  modulePairsReachable: number;
  modulePairsUnreachable: number;
  /** Ordered pairs (a, b), a ≠ b. */
  packagePairsReachable: number;
  packagePairsUnreachable: number;
}

export type WorkspaceGraphCautionKind =
  | "partial-coverage"
  | "module-graph-cross-package-only"
  | "usage-only-edges"
  | "corridor-enumeration-capped";

export interface WorkspaceGraphCaution {
  detail: string;
  entities: string[];
  kind: WorkspaceGraphCautionKind;
}

export interface WorkspaceGraphSummary {
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
