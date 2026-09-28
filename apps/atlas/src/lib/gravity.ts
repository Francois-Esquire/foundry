import { classifyFile } from "./file-kind";
import type {
  DependencyGravity,
  DependencyGravityReport,
  ModuleDependencyEdge,
  ModuleEdgeConcentration,
  ModuleRole,
  WorkspaceModuleGraph,
} from "./types";

/** The subset of `Boundary` gravity needs; kept structural for testability. */
export interface GravityBoundary {
  packageName?: string | undefined;
  relPath: string;
}

export interface Adjacency {
  into: Map<string, Set<string>>;
  nodes: string[];
  out: Map<string, Set<string>>;
}

export function buildAdjacency(
  nodes: Iterable<string>,
  edges: [string, string][]
): Adjacency {
  const out = new Map<string, Set<string>>();
  const into = new Map<string, Set<string>>();
  const nodeList: string[] = [];
  for (const node of nodes) {
    if (out.has(node)) {
      continue;
    }
    nodeList.push(node);
    out.set(node, new Set());
    into.set(node, new Set());
  }
  for (const [from, to] of edges) {
    if (from === to) {
      continue;
    }
    out.get(from)?.add(to);
    into.get(to)?.add(from);
  }
  return { into, nodes: nodeList, out };
}

/** Unique nodes reachable from `start` (excluding itself); cycle-safe BFS. */
export function reachableCount(
  start: string,
  adjacency: Map<string, Set<string>>
): number {
  const visited = new Set([start]);
  const queue = [start];
  // for-of sees elements appended during iteration, so this drains the queue
  for (const current of queue) {
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      queue.push(next);
    }
  }
  return visited.size - 1;
}

/** Iterative post-order finish times over out-edges (Kosaraju pass one). */
function finishOrder(graph: Adjacency): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  for (const root of graph.nodes) {
    if (visited.has(root)) {
      continue;
    }
    visited.add(root);
    const stack: { node: string; neighbors: string[]; index: number }[] = [
      { index: 0, neighbors: [...(graph.out.get(root) ?? [])], node: root },
    ];
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (frame === undefined) {
        break;
      }
      if (frame.index < frame.neighbors.length) {
        const next = frame.neighbors[frame.index];
        frame.index += 1;
        if (next !== undefined && !visited.has(next)) {
          visited.add(next);
          stack.push({
            index: 0,
            neighbors: [...(graph.out.get(next) ?? [])],
            node: next,
          });
        }
      } else {
        order.push(frame.node);
        stack.pop();
      }
    }
  }
  return order;
}

export interface Condensation {
  /** Node → its strongly connected component's id. */
  componentOf: Map<string, string>;
  /** Component-level DAG in the dependent direction. */
  into: Map<string, Set<string>>;
  /** Component-level DAG in the dependency direction. */
  out: Map<string, Set<string>>;
  size: Map<string, number>;
}

/** Kosaraju SCCs plus the acyclic component-level graph in both directions. */
export function condense(graph: Adjacency): Condensation {
  const componentOf = new Map<string, string>();
  const size = new Map<string, number>();
  const visitSeed = () => {
    for (const seed of finishOrder(graph).reverse()) {
      if (componentOf.has(seed)) {
        continue;
      }
      const members = [seed];
      componentOf.set(seed, seed);
      for (const current of members) {
        for (const next of graph.into.get(current) ?? []) {
          if (componentOf.has(next)) {
            continue;
          }
          componentOf.set(next, seed);
          members.push(next);
        }
      }
      size.set(seed, members.length);
    }
  };
  visitSeed();
  const out = new Map<string, Set<string>>();
  const into = new Map<string, Set<string>>();
  for (const component of size.keys()) {
    out.set(component, new Set());
    into.set(component, new Set());
  }
  for (const [from, targets] of graph.out) {
    const fromComponent = componentOf.get(from);
    if (fromComponent === undefined) {
      continue;
    }
    for (const to of targets) {
      const toComponent = componentOf.get(to);
      if (toComponent === undefined || toComponent === fromComponent) {
        continue;
      }
      out.get(fromComponent)?.add(toComponent);
      into.get(toComponent)?.add(fromComponent);
    }
  }
  return { componentOf, into, out, size };
}

/**
 * Longest path length (in edges) starting from each node. `adjacency` must be
 * acyclic — it is only ever the SCC condensation.
 */
export function longestPathLengths(
  adjacency: Map<string, Set<string>>
): Map<string, number> {
  const memo = new Map<string, number>();
  for (const start of adjacency.keys()) {
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.at(-1);
      if (node === undefined || memo.has(node)) {
        stack.pop();
        continue;
      }
      const pending = [...(adjacency.get(node) ?? [])].filter(
        (next) => !memo.has(next)
      );
      if (pending.length > 0) {
        stack.push(...pending);
        continue;
      }
      let best = 0;
      for (const next of adjacency.get(node) ?? []) {
        best = Math.max(best, 1 + (memo.get(next) ?? 0));
      }
      memo.set(node, best);
      stack.pop();
    }
  }
  return memo;
}

export interface MeasuredGraph {
  adjacency: Adjacency;
  condensation: Condensation;
  /** Longest dependent chain per component (downstream depth). */
  downstream: Map<string, number>;
  /** Longest dependency chain per component (upstream depth). */
  upstream: Map<string, number>;
}

export function measureGraph(
  nodes: Iterable<string>,
  edges: [string, string][]
): MeasuredGraph {
  const adjacency = buildAdjacency(nodes, edges);
  const condensation = condense(adjacency);
  return {
    adjacency,
    condensation,
    downstream: longestPathLengths(condensation.into),
    upstream: longestPathLengths(condensation.out),
  };
}

function gravityOf(
  id: string,
  kind: "package" | "module",
  graph: MeasuredGraph,
  population: number
): DependencyGravity {
  const component = graph.condensation.componentOf.get(id);
  const componentSize =
    component === undefined ? 1 : (graph.condensation.size.get(component) ?? 1);
  const dependents = reachableCount(id, graph.adjacency.into);
  const dependencies = reachableCount(id, graph.adjacency.out);
  const others = population - 1;
  return {
    cycle: {
      member: componentSize > 1,
      size: componentSize > 1 ? componentSize : 0,
    },
    depth: {
      downstream:
        component === undefined ? 0 : (graph.downstream.get(component) ?? 0),
      upstream:
        component === undefined ? 0 : (graph.upstream.get(component) ?? 0),
    },
    direct: {
      fanIn: graph.adjacency.into.get(id)?.size ?? 0,
      fanOut: graph.adjacency.out.get(id)?.size ?? 0,
    },
    node: { id, kind },
    reach: {
      dependencies: others > 0 ? dependencies / others : 0,
      dependents: others > 0 ? dependents / others : 0,
    },
    transitive: { dependencies, dependents },
  };
}

function concentration(
  edges: { fromFile: string; toFile: string }[],
  moduleOf: (edge: { fromFile: string; toFile: string }) => string
): ModuleEdgeConcentration[] {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const module = moduleOf(edge);
    counts.set(module, (counts.get(module) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([module, count]) => ({
      edges: count,
      module,
      share: edges.length > 0 ? count / edges.length : 0,
    }))
    .sort((a, b) => b.edges - a.edges || a.module.localeCompare(b.module));
}

/**
 * Dependency gravity over the workspace-wide module graph: fan-in/out,
 * cycle-safe transitive reach, condensation depth, and cycle membership for
 * the target package and each of its modules. Purely graph-derived — no
 * TypeScript project, no scoring, no thresholds. Modules owned by no
 * workspace package (`"<root>"`) are excluded.
 */
/**
 * Which workspace package each module belongs to (the target by boundary,
 * others by owner), and the module edges between owned modules. Modules
 * owned by no package are left out.
 */
export function workspacePackages(
  graph: WorkspaceModuleGraph,
  boundary: GravityBoundary
): { packageOf: Map<string, string>; moduleEdges: ModuleDependencyEdge[] } {
  const targetId = boundary.packageName ?? boundary.relPath;
  const inBoundary = (file: string) =>
    file === boundary.relPath || file.startsWith(`${boundary.relPath}/`);
  const packageOf = new Map<string, string>();
  for (const module of graph.modules) {
    if (inBoundary(module)) {
      packageOf.set(module, targetId);
      continue;
    }
    const owner = graph.owners[module];
    if (owner !== undefined && owner !== "<root>") {
      packageOf.set(module, owner);
    }
  }
  const moduleEdges = graph.edges.filter(
    (edge) => packageOf.has(edge.fromFile) && packageOf.has(edge.toFile)
  );
  return { moduleEdges, packageOf };
}

export function analyzeDependencyGravity(
  graph: WorkspaceModuleGraph,
  boundary: GravityBoundary,
  roles = new Map<string, ModuleRole>()
): DependencyGravityReport {
  const targetId = boundary.packageName ?? boundary.relPath;
  const inBoundary = (file: string) =>
    file === boundary.relPath || file.startsWith(`${boundary.relPath}/`);
  const { packageOf, moduleEdges } = workspacePackages(graph, boundary);

  const moduleGraph = measureGraph(
    packageOf.keys(),
    moduleEdges.map((edge) => [edge.fromFile, edge.toFile])
  );

  const packageNodes = new Set(packageOf.values());
  packageNodes.add(targetId);
  const packageGraph = measureGraph(
    [...packageNodes].sort((a, b) => a.localeCompare(b)),
    moduleEdges.flatMap((edge): [string, string][] => {
      const from = packageOf.get(edge.fromFile);
      const to = packageOf.get(edge.toFile);
      return from === undefined || to === undefined || from === to
        ? []
        : [[from, to]];
    })
  );

  const population = {
    modules: packageOf.size,
    packages: packageNodes.size,
  };
  const targetModules = graph.modules.filter(inBoundary);

  return {
    incomingConcentration: concentration(
      moduleEdges.filter(
        (edge) => inBoundary(edge.toFile) && !inBoundary(edge.fromFile)
      ),
      (edge) => edge.toFile
    ),
    internalEdges: moduleEdges.filter(
      (edge) => inBoundary(edge.fromFile) && inBoundary(edge.toFile)
    ),
    modules: targetModules.map((module) => {
      const role = roles.get(module);
      return {
        ...gravityOf(module, "module", moduleGraph, population.modules),
        ...(role !== undefined && { role }),
        fileKind: classifyFile(module),
      };
    }),
    outgoingConcentration: concentration(
      moduleEdges.filter(
        (edge) => inBoundary(edge.fromFile) && !inBoundary(edge.toFile)
      ),
      (edge) => edge.fromFile
    ),
    population,
    target: gravityOf(targetId, "package", packageGraph, population.packages),
  };
}
