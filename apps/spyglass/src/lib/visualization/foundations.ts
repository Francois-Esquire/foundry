import type { DependencyInventory } from "../dependency-inventory-types";
import type {
  DependencyFoundation,
  FoundationMember,
  InternalFoundation,
  IslandGeometry,
} from "./types";

type FoundationIsland = Pick<IslandGeometry, "id" | "x" | "y" | "radius">;

type DependencyGraph = NonNullable<DependencyInventory["graph"]>;
type DependencyEdge = DependencyGraph["edges"][number];

/** Each transitive step relies less, for third-party and workspace reliance alike. */
const relianceAttenuation = 0.45;

/** Only runtime installation chains form the default underwater geography. */
function isRuntime(edge: DependencyEdge): boolean {
  return edge.kind === "dependencies" || edge.kind === "optionalDependencies";
}

interface ReachedDependency {
  distance: number;
  usage?: FoundationMember["usage"];
  versions: Set<string>;
}

function recordReached(
  reached: Map<string, ReachedDependency>,
  node: DependencyGraph["nodes"][number] | undefined,
  edge: DependencyEdge,
  workspaceNames: ReadonlySet<string>,
  distance: number
): void {
  if (
    node?.kind === "workspace" ||
    (!node &&
      (workspaceNames.has(edge.name) || edge.range.startsWith("workspace:")))
  ) {
    return;
  }
  const name = node?.name ?? edge.name;
  const entry: ReachedDependency = reached.get(name) ?? {
    distance,
    versions: new Set<string>(),
  };
  entry.distance = Math.min(entry.distance, distance);
  if (node?.version) {
    entry.versions.add(node.version);
  }
  if (distance === 1 && edge.usage) {
    entry.usage = mergeUsage(entry.usage, edge.usage);
  }
  reached.set(name, entry);
}

function mergeUsage(
  previous: FoundationMember["usage"],
  next: NonNullable<FoundationMember["usage"]>
): NonNullable<FoundationMember["usage"]> {
  const runtimeFiles = new Set([
    ...(previous?.runtimeFiles ?? []),
    ...next.runtimeFiles,
  ]);
  return {
    importingFiles: [
      ...new Set([...(previous?.importingFiles ?? []), ...next.importingFiles]),
    ].sort(),
    runtimeFiles: [...runtimeFiles].sort(),
    typeOnlyFiles: [
      ...new Set([...(previous?.typeOnlyFiles ?? []), ...next.typeOnlyFiles]),
    ]
      .filter((file) => !runtimeFiles.has(file))
      .sort(),
  };
}

/** Declaration remains the baseline; observed imports refine it by at most a quarter. */
function usageStrength(usage: FoundationMember["usage"]): number {
  if (!usage) {
    return 1;
  }
  const runtime = usage.runtimeFiles.length;
  const types = usage.typeOnlyFiles.length;
  return (
    1 +
    Math.min(
      0.25,
      (0.25 * runtime) / (runtime + 4) + (0.1 * types) / (types + 4)
    )
  );
}

/** Breadth-first traversal counts a consumer once, even through diamonds or cycles. */
function dependenciesOf(
  consumer: string,
  outgoing: ReadonlyMap<string, readonly DependencyEdge[]>,
  nodes: ReadonlyMap<string, DependencyGraph["nodes"][number]>,
  workspaceNames: ReadonlySet<string>
): Map<string, ReachedDependency> {
  const reached = new Map<string, ReachedDependency>();
  const visited = new Set([consumer]);
  const queue = [{ distance: 0, id: consumer }];
  for (const item of queue) {
    for (const edge of outgoing.get(item.id) ?? []) {
      if (!isRuntime(edge)) {
        continue;
      }
      const node =
        edge.resolution === "resolved" && edge.target
          ? nodes.get(edge.target)
          : undefined;
      const distance = item.distance + 1;
      recordReached(reached, node, edge, workspaceNames, distance);
      if (node && !visited.has(node.id)) {
        visited.add(node.id);
        queue.push({ distance, id: node.id });
      }
    }
  }
  return reached;
}

/** Shared external names, with resolved versions preserved and shortest-path attenuation. */
export function deriveFoundations(
  inventory: DependencyInventory,
  territoryIds: readonly string[]
): DependencyFoundation[] {
  const { graph } = inventory;
  if (!graph) {
    return [];
  }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const workspaceNames = new Set([
    ...inventory.packages.map((pkg) => pkg.name),
    ...inventory.skipped.flatMap((pkg) => (pkg.name ? [pkg.name] : [])),
  ]);
  const outgoing = new Map<string, DependencyEdge[]>();
  for (const edge of graph.edges) {
    const edges = outgoing.get(edge.source) ?? [];
    edges.push(edge);
    outgoing.set(edge.source, edges);
  }
  const shared = new Map<
    string,
    { members: FoundationMember[]; versions: Set<string> }
  >();
  for (const territoryId of [...new Set(territoryIds)].sort()) {
    for (const [name, dependency] of dependenciesOf(
      territoryId,
      outgoing,
      nodes,
      workspaceNames
    )) {
      const entry = shared.get(name) ?? { members: [], versions: new Set() };
      entry.members.push({
        direct: dependency.distance === 1,
        distance: dependency.distance,
        territoryId,
        weight:
          relianceAttenuation ** (dependency.distance - 1) *
          usageStrength(dependency.usage),
        ...(dependency.usage && { usage: dependency.usage }),
      });
      for (const version of dependency.versions) {
        entry.versions.add(version);
      }
      shared.set(name, entry);
    }
  }
  return [...shared]
    .filter(([, entry]) => entry.members.length >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      id: `dependency:${name}`,
      lobes: [],
      members: entry.members,
      name,
      prominence: entry.members.length,
      versions: [...entry.versions].sort(),
      x: 0,
      y: 0,
    }));
}

/** Runtime edges from one workspace package to another, by source. */
function workspaceRuntimeEdges(graph: DependencyGraph): Map<string, string[]> {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const workspaceIds = new Map(
    graph.nodes
      .filter((node) => node.kind === "workspace")
      .map((node) => [node.name, node.id])
  );
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges.filter(isRuntime)) {
    const node =
      edge.resolution === "resolved" && edge.target
        ? nodes.get(edge.target)
        : undefined;
    // An unresolved declaration still names a workspace package.
    const target =
      node?.kind === "workspace" ? node.id : workspaceIds.get(edge.name);
    if (target && node?.kind !== "external") {
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), target]);
    }
  }
  return outgoing;
}

/** Breadth-first: every workspace package `consumer` relies on, at its shortest distance. */
function reliedUpon(
  consumer: string,
  outgoing: ReadonlyMap<string, readonly string[]>
): Map<string, number> {
  const distances = new Map([[consumer, 0]]);
  const queue = [consumer];
  for (const id of queue) {
    const distance = (distances.get(id) ?? 0) + 1;
    for (const target of [...new Set(outgoing.get(id) ?? [])].sort()) {
      if (!distances.has(target)) {
        distances.set(target, distance);
        queue.push(target);
      }
    }
  }
  distances.delete(consumer);
  return distances;
}

/**
 * Workspace packages that other workspace packages reach through runtime
 * chains, each with its dependents at their shortest distance. A supplier
 * with no third-party overlap, such as a shared `lib`, still appears here.
 * Development and peer chains are not structure; neither is a package
 * outside the islands given.
 */
export function deriveInternalFoundations(
  inventory: DependencyInventory,
  territoryIds: readonly string[]
): InternalFoundation[] {
  const { graph } = inventory;
  if (!graph) {
    return [];
  }
  const territories = new Set(territoryIds);
  const outgoing = workspaceRuntimeEdges(graph);
  const suppliers = new Map<string, InternalFoundation["members"]>();
  for (const consumer of [...territories].sort()) {
    for (const [supplierId, distance] of reliedUpon(consumer, outgoing)) {
      if (!territories.has(supplierId)) {
        continue;
      }
      const members = suppliers.get(supplierId) ?? [];
      members.push({
        direct: distance === 1,
        distance,
        territoryId: consumer,
        weight: relianceAttenuation ** (distance - 1),
      });
      suppliers.set(supplierId, members);
    }
  }
  return [...suppliers]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([supplierId, members]) => ({
      id: `workspace:${supplierId}`,
      members,
      prominence: members.length,
      supplierId,
    }));
}

/** Rebuild the visible field from settled islands; hiding it never changes geography. */
export function positionFoundations(
  foundations: readonly DependencyFoundation[],
  territories: readonly FoundationIsland[]
): DependencyFoundation[] {
  const byId = new Map(
    territories.map((territory) => [territory.id, territory])
  );
  return foundations.map((foundation) => {
    const lobes = foundation.members.flatMap((member) => {
      const territory = byId.get(member.territoryId);
      return territory
        ? [
            {
              radius: territory.radius + 20 + 12 * Math.sqrt(member.weight),
              territoryId: territory.id,
              weight: member.weight,
              x: territory.x,
              y: territory.y,
            },
          ]
        : [];
    });
    const total = lobes.reduce((sum, lobe) => sum + lobe.weight, 0) || 1;
    return {
      ...foundation,
      lobes,
      x: lobes.reduce((sum, lobe) => sum + lobe.x * lobe.weight, 0) / total,
      y: lobes.reduce((sum, lobe) => sum + lobe.y * lobe.weight, 0) / total,
    };
  });
}
