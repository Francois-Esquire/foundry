import type { DependencyInventory } from "../dependency-inventory-types";
import type {
  DependencyFoundation,
  FoundationMember,
  IslandGeometry,
} from "./types";

type FoundationIsland = Pick<IslandGeometry, "id" | "x" | "y" | "radius">;

type DependencyGraph = NonNullable<DependencyInventory["graph"]>;
type DependencyEdge = DependencyGraph["edges"][number];

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
          0.45 ** (dependency.distance - 1) * usageStrength(dependency.usage),
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
              radius: territory.radius + 55 + 35 * Math.sqrt(member.weight),
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

/** Bounded attraction toward shared centroids; adoption breadth never multiplies total force. */
export function createFoundationAttraction(
  foundations: readonly DependencyFoundation[],
  territories: readonly FoundationIsland[],
  influence: number
): { apply: () => void; connected: ReadonlySet<string> } {
  const byId = new Map(
    territories.map((territory) => [territory.id, territory])
  );
  const strength = Number.isFinite(influence)
    ? Math.max(0, Math.min(1, influence))
    : 0;
  const groups =
    strength > 0
      ? [...foundations]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((foundation) =>
            foundation.members
              .flatMap((member) => {
                const territory = byId.get(member.territoryId);
                return territory &&
                  member.weight > 0 &&
                  Number.isFinite(member.weight)
                  ? [{ territory, weight: member.weight }]
                  : [];
              })
              .sort((a, b) => a.territory.id.localeCompare(b.territory.id))
          )
          .filter((members) => members.length >= 2)
      : [];
  const connected = new Set(
    groups.flatMap((group) => group.map(({ territory }) => territory.id))
  );
  return {
    apply: () => applyFoundationAttraction(groups, strength),
    connected,
  };
}

function applyFoundationAttraction(
  groups: readonly { territory: FoundationIsland; weight: number }[][],
  influence: number
): void {
  const forces = new Map<
    FoundationIsland,
    { x: number; y: number; weight: number }
  >();
  for (const group of groups) {
    const total = group.reduce((sum, member) => sum + member.weight, 0);
    const x =
      group.reduce(
        (sum, member) => sum + member.territory.x * member.weight,
        0
      ) / total;
    const y =
      group.reduce(
        (sum, member) => sum + member.territory.y * member.weight,
        0
      ) / total;
    for (const { territory, weight } of group) {
      const pull = weight / Math.sqrt(group.length);
      const force = forces.get(territory) ?? { weight: 0, x: 0, y: 0 };
      force.x += (x - territory.x) * pull;
      force.y += (y - territory.y) * pull;
      force.weight += pull;
      forces.set(territory, force);
    }
  }
  for (const [territory, force] of forces) {
    const scale = (influence * 0.009) / Math.max(1, force.weight);
    const x = force.x * scale;
    const y = force.y * scale;
    const cap = Math.min(1, 3 / (Math.hypot(x, y) || 1));
    territory.x += x * cap;
    territory.y += y * cap;
  }
}
