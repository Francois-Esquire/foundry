import type { DependencyEdge } from "../dependency-graph-types";
import type { DependencyInventory } from "../dependency-inventory-types";
import { deriveFoundations } from "./foundations";
import { unit } from "./geography";
import { elevationAtDepth, elevationAtHeight } from "./geology";
import type { Polygon } from "./types";

/**
 * Sea stacks: small rock pillars and islets on the shelf off an island's
 * coast, one for each third-party package the island's package depends on
 * at runtime and no other workspace package reaches. A shared dependency
 * already raises a shelf under every package that relies on it; a
 * dependency of one package alone is that package's own, and stands off its
 * coast. The more the package relies on it, by the files that import it,
 * the taller, broader and nearer the coast the stack stands; the most
 * relied upon break the surface, and one declared but never imported is a
 * pinnacle under the water.
 *
 * A stack is often smaller than one cell of the terrain grid, so it is not a
 * seabed contribution: it is drawn as an instance over the world field and
 * never changes a coast. Placement is deterministic: each stack's bearing
 * from its island comes from its island's and its dependency's names, and a
 * stack that finds no clear water on its island's shelf is left out.
 */
export const defaultSeaStackSettings = {
  /** The most stacks on the chart, the most relied upon first. */
  cap: 40,
  /**
   * Map units kept clear between a stack's footprint and any coast, at
   * least one terrain cell so the seabed under it is never sampled as land,
   * and between two stacks' footprints.
   */
  clearance: { coast: 5, stack: 4 },
  /** Radians from vertical a stack leans seaward: none at full reliance, all of it at none. */
  lean: 0.14,
  /** The most stacks off one island. */
  perIsland: 5,
  /** Map units of a stack's footprint radius: least and most relied upon. */
  radius: { least: 1.2, most: 3 },
  /** How much a package relies on a dependency, 0 to 1, from the files that import it. */
  reliance: {
    /** Declared and analysed, but imported by no file. */
    declared: 0.1,
    /** Imported at runtime: from `base`, and half the rest at `half` files. */
    runtime: { base: 0.5, half: 4 },
    /** Imported, but only for its types. */
    typeOnly: 0.3,
    /** Declared, with no source analysis to say how it is used. */
    unmeasured: 0.5,
  },
  /** Map units from the coast to a stack's centre: the most relied upon at `inner`. */
  ring: { inner: 10, outer: 28 },
  /** A stack's top elevation: least relied upon 6 m under the water, most 90 m over it. */
  top: { least: elevationAtDepth(6), most: elevationAtHeight(90) },
  /** Bearings tried around the coast, alternating either side of the seeded one, before a stack is left out. */
  tries: 16,
};
export type SeaStackSettings = typeof defaultSeaStackSettings;

/** A third-party package one workspace package alone depends on at runtime. */
export interface OwnDependency {
  /** The dependency's package name. */
  name: string;
  /** 0 to 1: how much the package relies on it, from the files that import it. */
  reliance: number;
  /** The package's island. */
  territoryId: string;
}

export interface SeaStackIsland {
  /** Island-local, offset by `x` and `y`, as the structural terrain's. */
  coast: readonly Polygon[];
  id: string;
  radius: number;
  x: number;
  y: number;
}

/** Something a stack stands for, off one island's coast. */
export interface SeaStackSource {
  islandId: string;
  label?: string;
  /** The island first, then what the stack stands for; the stack's id joins them. */
  members: readonly string[];
  /** 0 to 1: how much the island relies on it. */
  reliance: number;
}

export interface SeaStackInput {
  islands: readonly SeaStackIsland[];
  sources: readonly SeaStackSource[];
}

/** One sea stack: a footprint on the shelf and the elevation of its top. */
export interface SeaStack {
  /** Elevation of the top, in `geologyLevels` units; above 0 it breaks the surface. */
  height: number;
  /** `stack:<members joined by +>`, stable for one input. */
  id: string;
  islandId: string;
  label?: string;
  /** How far the top leans from vertical, in radians, toward a bearing in the map's frame (x right, y down). */
  lean?: { angle: number; bearing: number };
  members: readonly string[];
  /** Map units of the footprint's radius. */
  radius: number;
  x: number;
  y: number;
}

type Point = [number, number];

function isRuntime(edge: DependencyEdge): boolean {
  return edge.kind === "dependencies" || edge.kind === "optionalDependencies";
}

/** How much a package relies on a dependency, from the files of the package that import it. */
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

/**
 * Each workspace package's own third-party dependencies: those it declares
 * at runtime, directly, that no other of `territoryIds` reaches through a
 * runtime chain, as `deriveFoundations` measures sharing. A dependency
 * reached only transitively is not the package's own choice, and
 * development and peer dependencies are not structure; neither is a stack.
 */
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

/** An island's coast in map units, with its bounding box for quick rejection. */
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

/** Each closed edge of a ring, as its two ends. */
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

/** Map units from a point to a shore's coast: negative on its land, by the even-odd rule. */
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

/** A lower bound on the map units from a point to a shore's coast. */
function boxDistance(shoreline: Shore, [x, y]: Point): number {
  const { bottom, left, right, top } = shoreline.box;
  return Math.hypot(
    Math.max(left - x, 0, x - right),
    Math.max(top - y, 0, y - bottom)
  );
}

/** How far from its centre a shore's coast last crosses a bearing: its outermost coast that way. */
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

/** Bearings to try: the seeded one first, then alternately either side of it. */
function bearings(seed: number, tries: number): number[] {
  const step = (2 * Math.PI) / Math.max(1, tries);
  return Array.from({ length: Math.max(1, tries) }, (_, k) => {
    const side = k % 2 === 1 ? 1 : -1;
    return seed + side * Math.ceil(k / 2) * step;
  });
}

/** Whether a footprint sits in clear water on its own island's shelf. */
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

/**
 * The stacks for each source, the most relied upon first: each off its own
 * island, on the shelf ring, clear of every coast and of the stacks before
 * it, at the first clear bearing from its seeded one. Each island takes at
 * most `perIsland` and the chart at most `cap`, so open water stays open.
 */
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
