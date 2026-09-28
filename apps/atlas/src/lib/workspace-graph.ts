import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type { Adjacency, MeasuredGraph } from "./gravity";
import { buildAdjacency, measureGraph, reachableCount } from "./gravity";
import type { ModuleRole } from "./types";
import type {
  WorkspaceComponent,
  WorkspaceCorridor,
  WorkspaceGraphAnalysis,
  WorkspaceGraphCaution,
  WorkspaceGraphCenters,
  WorkspaceLayer,
  WorkspaceLayerAnalysis,
  WorkspaceModuleGraphAnalysis,
  WorkspaceNodeGraphFacts,
  WorkspacePackageGraphAnalysis,
  WorkspacePackageGraphEdge,
  WorkspacePackageGraphRole,
  WorkspaceRankedNode,
  WorkspaceSeam,
  WorkspaceStrongComponent,
} from "./workspace-graph-types";
import type { WorkspaceReport } from "./workspace-types";

// V9.1 workspace graph intelligence. The canonical package and module
// graphs from a WorkspaceReport are analyzed as one system: every metric is
// recomputed from canonical nodes and edges, never merged from the
// per-package gravity each report derived from its own perspective. Package
// and module levels stay separate. Nothing here reads concepts, history, or
// V8 findings; anchors are carried as context only.

type GraphConfig = AnalysisConfig["workspaceGraph"];

function byId(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function sortedEdges(edges: [string, string][]): [string, string][] {
  return [...edges].sort((a, b) => byId(a[0], b[0]) || byId(a[1], b[1]));
}

// ---------------------------------------------------------------------------
// Generic directed-graph facts, shared by both levels

function reachableSet(start: string, adjacency: Map<string, Set<string>>) {
  const visited = new Set([start]);
  const queue = [start];
  for (const current of queue) {
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      queue.push(next);
    }
  }
  visited.delete(start);
  return visited;
}

/** Weak components over `nodes`, ignoring edge direction; ids are the smallest member. */
function weakComponents(
  nodes: readonly string[],
  adjacency: Adjacency,
  excluded?: string
): WorkspaceComponent[] {
  const seen = new Set<string>();
  const components: WorkspaceComponent[] = [];
  for (const root of nodes) {
    if (seen.has(root) || root === excluded) {
      continue;
    }
    seen.add(root);
    const members = [root];
    for (const current of members) {
      const neighbors = [
        ...(adjacency.out.get(current) ?? []),
        ...(adjacency.into.get(current) ?? []),
      ];
      for (const next of neighbors) {
        if (seen.has(next) || next === excluded) {
          continue;
        }
        seen.add(next);
        members.push(next);
      }
    }
    members.sort(byId);
    const id = members[0] ?? root;
    components.push({ id, nodes: members, size: members.length });
  }
  return components.sort((a, b) => byId(a.id, b.id));
}

function strongComponents(measured: MeasuredGraph): WorkspaceStrongComponent[] {
  const members = new Map<string, string[]>();
  for (const [node, component] of measured.condensation.componentOf) {
    const list = members.get(component) ?? [];
    list.push(node);
    members.set(component, list);
  }
  return [...members.values()]
    .filter((nodes) => nodes.length > 1)
    .map((nodes) => {
      nodes.sort(byId);
      const id = nodes[0] ?? "";
      return { id, nodes, size: nodes.length };
    })
    .sort((a, b) => byId(a.id, b.id));
}

interface Level {
  facts: Map<string, WorkspaceNodeGraphFacts>;
  measured: MeasuredGraph;
  nodes: string[];
  strong: WorkspaceStrongComponent[];
  strongOf: Map<string, string>;
  weak: WorkspaceComponent[];
  weakOf: Map<string, string>;
}

function measureLevel(nodes: string[], edges: [string, string][]): Level {
  const sortedNodes = [...nodes].sort(byId);
  const measured = measureGraph(sortedNodes, sortedEdges(edges));
  const weak = weakComponents(sortedNodes, measured.adjacency);
  const weakOf = new Map<string, string>();
  for (const component of weak) {
    for (const node of component.nodes) {
      weakOf.set(node, component.id);
    }
  }
  const strong = strongComponents(measured);
  const strongOf = new Map<string, string>();
  for (const component of strong) {
    for (const node of component.nodes) {
      strongOf.set(node, component.id);
    }
  }
  const others = sortedNodes.length - 1;
  const facts = new Map<string, WorkspaceNodeGraphFacts>();
  const visitNode = () => {
    for (const node of sortedNodes) {
      const component = measured.condensation.componentOf.get(node);
      const dependents = reachableCount(node, measured.adjacency.into);
      const dependencies = reachableCount(node, measured.adjacency.out);
      const upstream =
        component === undefined ? 0 : (measured.upstream.get(component) ?? 0);
      facts.set(node, {
        component: weakOf.get(node) ?? node,
        cycle: strongOf.has(node),
        depth: {
          downstream:
            component === undefined
              ? 0
              : (measured.downstream.get(component) ?? 0),
          upstream,
        },
        direct: {
          fanIn: measured.adjacency.into.get(node)?.size ?? 0,
          fanOut: measured.adjacency.out.get(node)?.size ?? 0,
        },
        layer: upstream,
        reach: {
          dependencyShare: others > 0 ? dependencies / others : 0,
          dependentShare: others > 0 ? dependents / others : 0,
        },
        strongComponent: strongOf.get(node) ?? null,
        transitive: { dependencies, dependents },
      });
    }
  };
  visitNode();
  return {
    facts,
    measured,
    nodes: sortedNodes,
    strong,
    strongOf,
    weak,
    weakOf,
  };
}

function layersOf(level: Level): WorkspaceLayer[] {
  const byLayer = new Map<number, string[]>();
  for (const node of level.nodes) {
    const layer = level.facts.get(node)?.layer ?? 0;
    const list = byLayer.get(layer) ?? [];
    list.push(node);
    byLayer.set(layer, list);
  }
  return [...byLayer.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, nodes]) => ({ index, nodes }));
}

function condensationLabel(level: Level, component: string): string {
  const cycle = level.strong.find((c) => c.id === component);
  return cycle === undefined ? component : `[${cycle.nodes.join("|")}]`;
}

/**
 * Longest source-to-sink paths on the condensation, longest first, ties by
 * id at every step. Cycle members are one node, so no order is invented
 * inside a cycle.
 */
function longestChains(level: Level, limit: number): string[][] {
  const { condensation, upstream } = level.measured;
  const depthOf = (component: string) => upstream.get(component) ?? 0;
  const starts = [...condensation.out.keys()]
    .filter(
      (c) => (condensation.into.get(c)?.size ?? 0) === 0 && depthOf(c) > 0
    )
    .sort((a, b) => depthOf(b) - depthOf(a) || byId(a, b));
  const chains: string[][] = [];
  const walk = (path: string[]) => {
    if (chains.length >= limit) {
      return;
    }
    const current = path.at(-1);
    if (current === undefined) {
      return;
    }
    const remaining = depthOf(current);
    if (remaining === 0) {
      chains.push(path.map((c) => condensationLabel(level, c)));
      return;
    }
    const next = [...(condensation.out.get(current) ?? [])]
      .filter((c) => depthOf(c) === remaining - 1)
      .sort(byId);
    for (const component of next) {
      walk([...path, component]);
    }
  };
  for (const start of starts) {
    walk([start]);
  }
  return chains;
}

function pairsReachable(level: Level): number {
  let total = 0;
  for (const facts of level.facts.values()) {
    total += facts.transitive.dependencies;
  }
  return total;
}

function sourcesOf(level: Level): string[] {
  return level.nodes.filter((node) => {
    const direct = level.facts.get(node)?.direct;
    return direct?.fanIn === 0 && direct.fanOut > 0;
  });
}

function sinksOf(level: Level): string[] {
  return level.nodes.filter((node) => {
    const direct = level.facts.get(node)?.direct;
    return direct?.fanOut === 0 && direct.fanIn > 0;
  });
}

function density(nodes: number, edges: number): number | null {
  return nodes < 2 ? null : edges / (nodes * (nodes - 1));
}

// ---------------------------------------------------------------------------
// Package-level structure: betweenness, articulation, edge facts

interface Betweenness {
  edge: Map<string, number>;
  node: Map<string, number>;
}

/** Brandes on the directed unweighted graph; neighbors visited in id order. */
function brandes(adjacency: Adjacency): Betweenness {
  const node = new Map<string, number>();
  const edge = new Map<string, number>();
  for (const s of adjacency.nodes) {
    node.set(s, 0);
  }
  brandesS(adjacency, edge, node);
  return { edge, node };
}

function brandesS(
  adjacency: Adjacency,
  edge: Map<string, number>,
  node: Map<string, number>
) {
  for (const s of adjacency.nodes) {
    const stack: string[] = [];
    const predecessors = new Map<string, string[]>();
    const sigma = new Map<string, number>([[s, 1]]);
    const distance = new Map<string, number>([[s, 0]]);
    const queue = [s];
    brandesSV(queue, stack, distance, adjacency, sigma, predecessors);
    const delta = new Map<string, number>();
    while (stack.length > 0) {
      const w = stack.pop();
      if (w === undefined) {
        break;
      }
      for (const v of predecessors.get(w) ?? []) {
        const share =
          ((sigma.get(v) ?? 0) / (sigma.get(w) ?? 1)) *
          (1 + (delta.get(w) ?? 0));
        const id = `${v}→${w}`;
        edge.set(id, (edge.get(id) ?? 0) + share);
        delta.set(v, (delta.get(v) ?? 0) + share);
      }
      if (w !== s) {
        node.set(w, (node.get(w) ?? 0) + (delta.get(w) ?? 0));
      }
    }
  }
}

function brandesSV(
  queue: string[],
  stack: string[],
  distance: Map<string, number>,
  adjacency: Adjacency,
  sigma: Map<string, number>,
  predecessors: Map<string, string[]>
) {
  for (const v of queue) {
    stack.push(v);
    const dv = distance.get(v) ?? 0;
    for (const w of [...(adjacency.out.get(v) ?? [])].sort(byId)) {
      if (!distance.has(w)) {
        distance.set(w, dv + 1);
        queue.push(w);
      }
      if (distance.get(w) === dv + 1) {
        sigma.set(w, (sigma.get(w) ?? 0) + (sigma.get(v) ?? 0));
        const list = predecessors.get(w) ?? [];
        list.push(v);
        predecessors.set(w, list);
      }
    }
  }
}

function articulationPackages(level: Level): string[] {
  const baseline = level.weak.length;
  return level.nodes.filter((node) => {
    const facts = level.facts.get(node);
    if (facts === undefined || facts.direct.fanIn + facts.direct.fanOut === 0) {
      return false;
    }
    return (
      weakComponents(level.nodes, level.measured.adjacency, node).length >
      baseline
    );
  });
}

interface EdgeStructure {
  alternativeRoutes: number;
  separates: { from: number; to: number } | null;
  severedPairs: number;
  weakBridge: boolean;
}

function edgeStructure(
  level: Level,
  edges: [string, string][],
  from: string,
  to: string
): EdgeStructure {
  const reduced = buildAdjacency(
    level.nodes,
    edges.filter(([a, b]) => a !== from || b !== to)
  );
  let lost = 0;
  for (const node of level.nodes) {
    const before = reachableSet(node, level.measured.adjacency.out);
    const after = reachableSet(node, reduced.out);
    for (const target of before) {
      if (!after.has(target)) {
        lost += 1;
      }
    }
  }
  const direct = reachableSet(from, reduced.out).has(to);
  let alternativeRoutes = 0;
  for (const hop of reduced.out.get(from) ?? []) {
    if (hop === to || reachableSet(hop, reduced.out).has(to)) {
      alternativeRoutes += 1;
    }
  }
  const components = weakComponents(level.nodes, reduced);
  const weakBridge = components.length > level.weak.length;
  const sizeOf = (node: string) =>
    components.find((c) => c.nodes.includes(node))?.size ?? 1;
  return {
    alternativeRoutes,
    separates: weakBridge ? { from: sizeOf(from), to: sizeOf(to) } : null,
    severedPairs: lost - (direct ? 0 : 1),
    weakBridge,
  };
}

// ---------------------------------------------------------------------------
// Corridors: shared shortest-route segments on the package graph

interface CorridorSearch {
  capped: string[];
  corridors: WorkspaceCorridor[];
}

function findCorridors(
  level: Level,
  config: GraphConfig["corridors"]
): CorridorSearch {
  const { out } = level.measured.adjacency;
  const supporters = new Map<
    string,
    {
      packages: string[];
      pairs: Set<string>;
      sources: Set<string>;
      destinations: Set<string>;
    }
  >();
  const capped: string[] = [];
  for (const source of level.nodes) {
    const distance = new Map<string, number>([[source, 0]]);
    const sigma = new Map<string, number>([[source, 1]]);
    const predecessors = new Map<string, string[]>();
    const queue = [source];
    for (const v of queue) {
      const dv = distance.get(v) ?? 0;
      for (const w of [...(out.get(v) ?? [])].sort(byId)) {
        if (!distance.has(w)) {
          distance.set(w, dv + 1);
          queue.push(w);
        }
        if (distance.get(w) === dv + 1) {
          sigma.set(w, (sigma.get(w) ?? 0) + (sigma.get(v) ?? 0));
          const list = predecessors.get(w) ?? [];
          list.push(v);
          predecessors.set(w, list);
        }
      }
    }
    findCorridorsDestination(
      level,
      distance,
      config,
      sigma,
      capped,
      source,
      predecessors,
      supporters
    );
  }
  const qualifying = [...supporters.entries()].filter(
    ([, entry]) => entry.pairs.size >= config.minSupport
  );
  const contains = (outer: string[], inner: string[]) => {
    if (inner.length >= outer.length) {
      return false;
    }
    for (let i = 0; i + inner.length <= outer.length; i += 1) {
      if (inner.every((node, j) => outer[i + j] === node)) {
        return true;
      }
    }
    return false;
  };
  const corridors = qualifying
    .filter(
      ([, entry]) =>
        !qualifying.some(([, other]) =>
          contains(other.packages, entry.packages)
        )
    )
    .map(([id, entry]): WorkspaceCorridor => {
      const pairs = [...entry.pairs].sort(byId);
      return {
        destinationPackages: [...entry.destinations].sort(byId),
        evidence: pairs.map((pair) => ({
          entities: pair.split("→"),
          kind: "shortest-path",
          value: entry.packages.length - 1,
        })),
        id,
        length: entry.packages.length - 1,
        packages: entry.packages,
        sourcePackages: [...entry.sources].sort(byId),
        support: pairs.length,
      };
    })
    .sort(
      (a, b) => b.support - a.support || b.length - a.length || byId(a.id, b.id)
    );
  return { capped: capped.sort(byId), corridors };
}

function findCorridorsDestination(
  level: Level,
  distance: Map<string, number>,
  config: { minSupport: number; minLength: number; maxPathsPerPair: number },
  sigma: Map<string, number>,
  capped: string[],
  source: string,
  predecessors: Map<string, string[]>,
  supporters: Map<
    string,
    {
      packages: string[];
      pairs: Set<string>;
      sources: Set<string>;
      destinations: Set<string>;
    }
  >
) {
  for (const destination of level.nodes) {
    const length = distance.get(destination);
    if (length === undefined || length < config.minLength) {
      continue;
    }
    if ((sigma.get(destination) ?? 0) > config.maxPathsPerPair) {
      capped.push(`${source}→${destination}`);
      continue;
    }
    const paths: string[][] = [];
    const walk = (path: string[]) => {
      const [head] = path;
      if (head === undefined) {
        return;
      }
      if (head === source) {
        paths.push(path);
        return;
      }
      for (const previous of [...(predecessors.get(head) ?? [])].sort(byId)) {
        walk([previous, ...path]);
      }
    };
    walk([destination]);
    const pair = `${source}→${destination}`;
    for (const path of paths) {
      for (let start = 0; start < path.length; start += 1) {
        for (let end = start + config.minLength; end < path.length; end += 1) {
          const packages = path.slice(start, end + 1);
          const id = packages.join("→");
          const entry = supporters.get(id) ?? {
            destinations: new Set<string>(),
            packages,
            pairs: new Set<string>(),
            sources: new Set<string>(),
          };
          entry.pairs.add(pair);
          entry.sources.add(source);
          entry.destinations.add(destination);
          supporters.set(id, entry);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Assembly

function ranked(
  entries: { id: string; value: number; role?: ModuleRole }[],
  limit: number
): WorkspaceRankedNode[] {
  return entries
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || byId(a.id, b.id))
    .slice(0, limit);
}

function roleOf(facts: WorkspaceNodeGraphFacts): WorkspacePackageGraphRole {
  const { fanIn, fanOut } = facts.direct;
  if (fanIn === 0 && fanOut === 0) {
    return "isolated";
  }
  if (fanIn === 0) {
    return "source";
  }
  if (fanOut === 0) {
    return "sink";
  }
  return "intermediate";
}

/**
 * Analyze the canonical workspace graphs. Pure over the report; package
 * analysis, TypeScript, and Git are never rerun.
 */
export function analyzeWorkspaceGraph(
  workspace: WorkspaceReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): WorkspaceGraphAnalysis {
  const policy = config.workspaceGraph;
  const { graph } = workspace;

  const packageNodes = graph.packages.map((p) => p.package);
  const usageOnlyEdges = graph.dependencyEdges
    .filter((edge) => edge.moduleEdges === 0)
    .map((edge) => edge.id)
    .sort(byId);
  const importEdges = graph.dependencyEdges.filter(
    (edge) => edge.moduleEdges > 0
  );
  const packageEdgePairs = importEdges.map((edge): [string, string] => [
    edge.from,
    edge.to,
  ]);
  const packages = measureLevel(packageNodes, packageEdgePairs);

  const moduleNodes = graph.modules.map((moduleEntry2) => moduleEntry2.id);
  const modules = measureLevel(
    moduleNodes,
    graph.moduleEdges.map((edge): [string, string] => [edge.from, edge.to])
  );

  const centrality = brandes(packages.measured.adjacency);
  const n = packages.nodes.length;
  const nodePairs = n > 2 ? (n - 1) * (n - 2) : 0;
  const edgePairs = n > 1 ? n * (n - 1) : 0;
  const articulation = new Set(articulationPackages(packages));

  const anchored = new Map(graph.packages.map((p) => [p.package, p.anchored]));
  const analyzed = new Map(graph.packages.map((p) => [p.package, p.analyzed]));

  const packageAnalyses = packages.nodes.map(
    (id): WorkspacePackageGraphAnalysis => {
      const facts = packages.facts.get(id);
      if (facts === undefined) {
        throw new Error(`unmeasured package ${id}`);
      }
      return {
        analyzed: analyzed.get(id) ?? false,
        anchored: anchored.get(id) ?? false,
        package: id,
        ...facts,
        articulation: articulation.has(id),
        betweenness:
          nodePairs > 0 ? (centrality.node.get(id) ?? 0) / nodePairs : 0,
        role: roleOf(facts),
      };
    }
  );

  const boundaries = new Map(
    workspace.boundaries.boundaries.map((b) => [b.id, b])
  );
  const edges = [...importEdges]
    .sort((a, b) => byId(a.id, b.id))
    .map((edge): WorkspacePackageGraphEdge => {
      const boundary = boundaries.get(edge.id);
      return {
        betweenness:
          edgePairs > 0 ? (centrality.edge.get(edge.id) ?? 0) / edgePairs : 0,
        from: edge.from,
        id: edge.id,
        to: edge.to,
        verified: edge.verified,
        weights: {
          distinctSymbols: boundary?.symbols.distinct ?? null,
          importSites: boundary?.importSites ?? null,
          moduleEdges: edge.moduleEdges,
          references: boundary?.symbols.references ?? null,
        },
        ...edgeStructure(packages, packageEdgePairs, edge.from, edge.to),
      };
    });

  const seams = edges
    .filter(
      (edge) =>
        edge.severedPairs >= policy.seams.minSeveredPairs ||
        (edge.weakBridge &&
          edge.separates !== null &&
          Math.min(edge.separates.from, edge.separates.to) >=
            policy.seams.minRegionSize)
    )
    .map((edge): WorkspaceSeam => {
      const anchoredEnds = [edge.from, edge.to].filter(
        (id) => anchored.get(id) === true
      );
      return {
        alternativePaths: edge.alternativeRoutes,
        anchored: anchoredEnds,
        boundary: edge.id,
        bridgeStrength: edge.betweenness,
        downstreamPackages:
          (packages.facts.get(edge.to)?.transitive.dependencies ?? 0) + 1,
        evidence: [
          {
            entities: [edge.id],
            kind: "dependency-edge",
            value: edge.weights.moduleEdges,
          },
          {
            entities: [edge.id],
            kind: "reachability",
            value: edge.severedPairs,
          },
          {
            entities: [edge.id],
            kind: "shortest-path",
            value: edge.betweenness,
          },
          ...(edge.weakBridge
            ? [{ entities: [edge.id], kind: "component" as const, value: true }]
            : []),
          ...anchoredEnds.map((id) => ({
            entities: [id],
            kind: "anchor" as const,
          })),
        ],
        from: edge.from,
        id: edge.id,
        severedPairs: edge.severedPairs,
        to: edge.to,
        upstreamPackages:
          (packages.facts.get(edge.from)?.transitive.dependents ?? 0) + 1,
        weakBridge: edge.weakBridge,
      };
    })
    .sort(
      (a, b) =>
        b.severedPairs - a.severedPairs ||
        (b.bridgeStrength ?? 0) - (a.bridgeStrength ?? 0) ||
        byId(a.id, b.id)
    );

  const { corridors, capped } = findCorridors(packages, policy.corridors);

  const roles = new Map(
    graph.modules.flatMap((moduleEntry) =>
      moduleEntry.role === undefined
        ? []
        : [[moduleEntry.id, moduleEntry.role] as const]
    )
  );
  const packageOf = new Map(
    graph.modules.flatMap((moduleEntry4) =>
      moduleEntry4.package === undefined
        ? []
        : [[moduleEntry4.id, moduleEntry4.package] as const]
    )
  );
  const moduleAnalyses = modules.nodes.map(
    (id): WorkspaceModuleGraphAnalysis => {
      const facts = modules.facts.get(id);
      if (facts === undefined) {
        throw new Error(`unmeasured module ${id}`);
      }
      const pkg = packageOf.get(id);
      const role = roles.get(id);
      return {
        module: id,
        ...(pkg !== undefined && { package: pkg }),
        ...(role !== undefined && { role }),
        ...facts,
      };
    }
  );

  const centers: WorkspaceGraphCenters = {
    bridgePackages: ranked(
      packageAnalyses.map((p) => ({ id: p.package, value: p.betweenness })),
      policy.report.topPackages
    ),
    highDependencyReachPackages: ranked(
      packageAnalyses.map((p) => ({
        id: p.package,
        value: p.transitive.dependencies,
      })),
      policy.report.topPackages
    ),
    highDependentReachPackages: ranked(
      packageAnalyses.map((p) => ({
        id: p.package,
        value: p.transitive.dependents,
      })),
      policy.report.topPackages
    ),
    highFanInModules: ranked(
      moduleAnalyses.map((moduleEntry3) => ({
        id: moduleEntry3.module,
        value: moduleEntry3.direct.fanIn,
        ...(moduleEntry3.role !== undefined && { role: moduleEntry3.role }),
      })),
      policy.report.topModules
    ),
    highFanInPackages: ranked(
      packageAnalyses.map((p) => ({ id: p.package, value: p.direct.fanIn })),
      policy.report.topPackages
    ),
    highFanOutPackages: ranked(
      packageAnalyses.map((p) => ({ id: p.package, value: p.direct.fanOut })),
      policy.report.topPackages
    ),
  };

  const packageLayers = layersOf(packages);
  const moduleLayers = layersOf(modules);
  const layers: WorkspaceLayerAnalysis = {
    maxModuleDepth: moduleLayers.length > 0 ? moduleLayers.length - 1 : 0,
    maxPackageDepth: packageLayers.length > 0 ? packageLayers.length - 1 : 0,
    moduleLayers,
    packageLayers,
  };

  const { coverage } = workspace.ingestion;
  const cautions: WorkspaceGraphCaution[] = [];
  if (!coverage.complete) {
    cautions.push({
      detail: `${coverage.packagesAnalyzed} of ${coverage.population ?? coverage.packagesKnown} packages analyzed; edges touching unanalyzed packages are known only from the analyzed side, so fan-in, fan-out, reach, seams, and corridors are lower bounds`,
      entities: coverage.missingPackages,
      kind: "partial-coverage",
    });
  }
  const crossPackageOnly =
    graph.moduleEdges.length > 0 &&
    graph.moduleEdges.every((edge) => edge.fromPackage !== edge.toPackage);
  if (crossPackageOnly) {
    cautions.push({
      detail:
        "canonical module edges all cross package boundaries; module fan-in, reach, depth, and layers describe boundary-crossing topology, not internal package structure",
      entities: [],
      kind: "module-graph-cross-package-only",
    });
  }
  if (usageOnlyEdges.length > 0) {
    cautions.push({
      detail:
        "dependency edges observed through re-exported symbols only, with no import module edges; excluded from the package graph",
      entities: usageOnlyEdges,
      kind: "usage-only-edges",
    });
  }
  if (capped.length > 0) {
    cautions.push({
      detail: `pairs with more than ${policy.corridors.maxPathsPerPair} shortest routes were skipped`,
      entities: capped,
      kind: "corridor-enumeration-capped",
    });
  }

  const packageSources = sourcesOf(packages);
  const packageSinks = sinksOf(packages);
  const packagePairsReachable = pairsReachable(packages);
  const modulePairsReachable = pairsReachable(modules);
  const m = modules.nodes.length;

  return {
    cautions,
    centers,
    certainty: coverage.complete ? "complete" : "partial",
    corridors,
    cycles: {
      largestModuleCycle: modules.strong.reduce(
        (best, c) => Math.max(best, c.size),
        0
      ),
      moduleCycles: modules.strong.length,
      moduleStrongComponents: modules.strong,
      packageCycles: packages.strong.length,
      packageStrongComponents: packages.strong,
    },
    edges,
    layers,
    modules: moduleAnalyses,
    packages: packageAnalyses,
    population: { modules: m, packages: n },
    reachability: {
      longestModuleChains: longestChains(modules, policy.report.topChains),
      longestPackageChains: longestChains(packages, policy.report.topChains),
      modulePairsReachable,
      modulePairsUnreachable: m * (m - 1) - modulePairsReachable,
      packagePairsReachable,
      packagePairsUnreachable: n * (n - 1) - packagePairsReachable,
    },
    seams,
    summary: {
      components: packages.weak.length,
      corridors: corridors.length,
      cycles: packages.strong.length,
      maxModuleDepth: layers.maxModuleDepth,
      maxPackageDepth: layers.maxPackageDepth,
      packageEdges: edges.length,
      packages: n,
      seams: seams.length,
      sinks: packageSinks.length,
      sources: packageSources.length,
    },
    topology: {
      articulationPackages: [...articulation].sort(byId),
      connectedComponents: packages.weak.length,
      moduleConnectedComponents: modules.weak.length,
      moduleDensity: density(m, graph.moduleEdges.length),
      moduleEdges: graph.moduleEdges.length,
      moduleNodes: m,
      moduleSinks: sinksOf(modules),
      moduleSources: sourcesOf(modules),
      packageComponents: packages.weak,
      packageDensity: density(n, edges.length),
      packageEdges: edges.length,
      packageIsolated: packageAnalyses
        .filter((p) => p.role === "isolated")
        .map((p) => p.package),
      packageNodes: n,
      packageSinks,
      packageSources,
      usageOnlyEdges,
    },
  };
}
