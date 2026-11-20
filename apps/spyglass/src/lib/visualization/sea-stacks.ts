import type { DependencyEdge } from "../dependency-graph-types";
import type { DependencyInventory } from "../dependency-inventory-types";
import { deriveFoundations } from "./foundations";
import { unit } from "./geography";
import { elevationAtDepth, elevationAtHeight } from "./geology";
import type { Polygon } from "./types";

export const defaultSeaStackSettings = {
  cap: 40,
  clearance: { coast: 6, stack: 6 },
  lean: 0.14,
  perIsland: 5,
  radius: { least: 3.5, most: 8 },
  reliance: {
    declared: 0.1,
    runtime: { base: 0.5, half: 4 },
    typeOnly: 0.3,
    unmeasured: 0.5,
  },
  ring: { inner: 18, outer: 52 },
  top: { least: elevationAtDepth(4), most: elevationAtHeight(150) },
  tries: 16,
};
export type SeaStackSettings = typeof defaultSeaStackSettings;

export interface OwnDependency {
  name: string;
  reliance: number;
  territoryId: string;
}

export interface SeaStackIsland {
  coast: readonly Polygon[];
  id: string;
  radius: number;
  x: number;
  y: number;
}

export interface SeaStackSource {
  islandId: string;
  label?: string;
  members: readonly string[];
  reliance: number;
}

export interface SeaStackInput {
  islands: readonly SeaStackIsland[];
  sources: readonly SeaStackSource[];
}

export interface SeaStack {
  height: number;
  id: string;
  islandId: string;
  label?: string;
  lean?: { angle: number; bearing: number };
  members: readonly string[];
  radius: number;
  x: number;
  y: number;
}

type Point = [number, number];

function isRuntime(edge: DependencyEdge): boolean {
  return edge.kind === "dependencies" || edge.kind === "optionalDependencies";
}

function relianceOf(
  usage: DependencyEdge["usage"],
  settings: SeaStackSettings["reliance"]
): number {
  if (!usage) {
    return settings.unmeasured;
  }
  const runtime = usage.runtimeFiles.length;
  if (runtime > 0) {
    const { base, half } = settings.runtime;
    return base + ((1 - base) * runtime) / (runtime + half);
  }
  return usage.typeOnlyFiles.length > 0 ? settings.typeOnly : settings.declared;
}

export function ownDependencies(
  inventory: DependencyInventory,
  territoryIds: readonly string[],
  settings: SeaStackSettings = defaultSeaStackSettings
): OwnDependency[] {
  const { graph } = inventory;
  if (!graph) {
    return [];
  }
  const shared = new Set(
    deriveFoundations(inventory, territoryIds).map(({ name }) => name)
  );
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const workspaceNames = new Set([
    ...inventory.packages.map((pkg) => pkg.name),
    ...inventory.skipped.flatMap((pkg) => (pkg.name ? [pkg.name] : [])),
  ]);
  const territories = new Set(territoryIds);
  const found = new Map<string, OwnDependency>();
  for (const edge of graph.edges) {
    if (!(territories.has(edge.source) && isRuntime(edge))) {
      continue;
    }
    const node =
      edge.resolution === "resolved" && edge.target
        ? nodes.get(edge.target)
        : undefined;
    const workspace =
      node?.kind === "workspace" ||
      (!node &&
        (workspaceNames.has(edge.name) || edge.range.startsWith("workspace:")));
    const name = node?.name ?? edge.name;
    if (workspace || shared.has(name)) {
      continue;
    }
    const key = JSON.stringify([edge.source, name]);
    const reliance = relianceOf(edge.usage, settings.reliance);
    const previous = found.get(key);
    if (!previous || reliance > previous.reliance) {
      found.set(key, { name, reliance, territoryId: edge.source });
    }
  }
  return [...found.values()].sort(
    (a, b) =>
      a.territoryId.localeCompare(b.territoryId) || a.name.localeCompare(b.name)
  );
}

interface Shore {
  box: { bottom: number; left: number; right: number; top: number };
  id: string;
  polygons: Point[][][];
  radius: number;
  x: number;
  y: number;
}

function fallbackCoast(radius: number): Polygon[] {
  const ring: Point[] = Array.from({ length: 32 }, (_, i) => [
    Math.cos((i * Math.PI) / 16) * radius,
    Math.sin((i * Math.PI) / 16) * radius,
  ]);
  return [[ring]];
}

function shore(island: SeaStackIsland): Shore {
  const coast = island.coast.length
    ? island.coast
    : fallbackCoast(Math.max(1, island.radius));
  const polygons = coast.map((polygon) =>
    polygon.map((ring) =>
      ring.map(([x, y]): Point => [island.x + x, island.y + y])
    )
  );
  const points = polygons.flat(2);
  return {
    box: {
      bottom: Math.max(...points.map(([, y]) => y)),
      left: Math.min(...points.map(([x]) => x)),
      right: Math.max(...points.map(([x]) => x)),
      top: Math.min(...points.map(([, y]) => y)),
    },
    id: island.id,
    polygons,
    radius: Math.max(1, island.radius),
    x: island.x,
    y: island.y,
  };
}

function* edges(ring: readonly Point[]): Generator<[Point, Point]> {
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    if (a && b) {
      yield [a, b];
    }
  }
}

function segmentDistance([x, y]: Point, [ax, ay]: Point, [bx, by]: Point) {
  const dx = bx - ax;
  const dy = by - ay;
  const span = dx * dx + dy * dy;
  const t =
    span > 0
      ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / span))
      : 0;
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}

function signedDistance(shoreline: Shore, point: Point): number {
  let nearest = Number.POSITIVE_INFINITY;
  let inside = false;
  for (const polygon of shoreline.polygons) {
    let crossings = 0;
    for (const ring of polygon) {
      for (const [a, b] of edges(ring)) {
        nearest = Math.min(nearest, segmentDistance(point, a, b));
        const [, y] = point;
        if (a[1] > y !== b[1] > y) {
          const x = a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
          if (x > point[0]) {
            crossings += 1;
          }
        }
      }
    }
    inside ||= crossings % 2 === 1;
  }
  return inside ? -nearest : nearest;
}

function boxDistance(shoreline: Shore, [x, y]: Point): number {
  const { bottom, left, right, top } = shoreline.box;
  return Math.hypot(
    Math.max(left - x, 0, x - right),
    Math.max(top - y, 0, y - bottom)
  );
}

function reach(shoreline: Shore, direction: Point): number {
  let farthest = -1;
  const [dx, dy] = direction;
  for (const ring of shoreline.polygons.flat()) {
    for (const [a, b] of edges(ring)) {
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const denominator = dx * ey - dy * ex;
      if (Math.abs(denominator) < 1e-12) {
        continue;
      }
      const ox = a[0] - shoreline.x;
      const oy = a[1] - shoreline.y;
      const t = (ox * ey - oy * ex) / denominator;
      const s = (ox * dy - oy * dx) / denominator;
      if (t >= 0 && s >= 0 && s <= 1) {
        farthest = Math.max(farthest, t);
      }
    }
  }
  return farthest >= 0 ? farthest : shoreline.radius;
}

function bearings(seed: number, tries: number): number[] {
  const step = (2 * Math.PI) / Math.max(1, tries);
  return Array.from({ length: Math.max(1, tries) }, (_, k) => {
    const side = k % 2 === 1 ? 1 : -1;
    return seed + side * Math.ceil(k / 2) * step;
  });
}

function clearWater(
  shores: readonly Shore[],
  owner: Shore,
  point: Point,
  radius: number,
  settings: SeaStackSettings
): boolean {
  const own = signedDistance(owner, point);
  if (own < radius + settings.clearance.coast || own > settings.ring.outer) {
    return false;
  }
  return shores.every(
    (other) =>
      other === owner ||
      boxDistance(other, point) > own ||
      signedDistance(other, point) > own
  );
}

export function seaStacks(
  input: SeaStackInput,
  settings: SeaStackSettings = defaultSeaStackSettings
): SeaStack[] {
  const shores = [...input.islands]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(shore);
  const byId = new Map(shores.map((each) => [each.id, each]));
  const ranked = input.sources
    .map((source) => ({
      ...source,
      id: `stack:${source.members.join("+")}`,
      reliance: Math.min(1, Math.max(0, source.reliance)),
    }))
    .sort((a, b) => b.reliance - a.reliance || a.id.localeCompare(b.id));
  const placed: SeaStack[] = [];
  const perIsland = new Map<string, number>();
  for (const source of ranked) {
    if (placed.length >= settings.cap) {
      break;
    }
    const owner = byId.get(source.islandId);
    const count = perIsland.get(source.islandId) ?? 0;
    if (!owner || count >= settings.perIsland) {
      continue;
    }
    const stack = place(source, owner, shores, placed, settings);
    if (stack) {
      placed.push(stack);
      perIsland.set(source.islandId, count + 1);
    }
  }
  return placed;
}

function place(
  source: SeaStackSource & { id: string },
  owner: Shore,
  shores: readonly Shore[],
  placed: readonly SeaStack[],
  settings: SeaStackSettings
): SeaStack | undefined {
  const { reliance } = source;
  const radius =
    settings.radius.least +
    (settings.radius.most - settings.radius.least) * reliance;
  const offset =
    settings.ring.outer -
    (settings.ring.outer - settings.ring.inner) * reliance;
  for (const bearing of bearings(
    2 * Math.PI * unit(source.id),
    settings.tries
  )) {
    const direction: Point = [Math.cos(bearing), Math.sin(bearing)];
    const out = reach(owner, direction) + offset;
    const point: Point = [
      owner.x + direction[0] * out,
      owner.y + direction[1] * out,
    ];
    const apart = placed.every(
      (other) =>
        Math.hypot(other.x - point[0], other.y - point[1]) >=
        other.radius + radius + settings.clearance.stack
    );
    if (apart && clearWater(shores, owner, point, radius, settings)) {
      const angle = settings.lean * (1 - reliance);
      return {
        height:
          settings.top.least +
          (settings.top.most - settings.top.least) * reliance,
        id: source.id,
        islandId: source.islandId,
        ...(source.label && { label: source.label }),
        ...(angle > 0 && { lean: { angle, bearing } }),
        members: [...source.members],
        radius,
        x: point[0],
        y: point[1],
      };
    }
  }
}
