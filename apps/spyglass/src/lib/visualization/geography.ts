import { createFoundationAttraction } from "./affinity";
import { createCoastSeparation } from "./coast-collision";
import type { DependencyFoundation, IslandGeometry } from "./types";

function latitude(layer: number): number {
  return -220 * layer;
}
function attraction(strength: number): number {
  return Math.log2(2 + strength);
}

export function unit(id: string): number {
  let h = 2_166_136_261;
  for (const c of id) {
    // biome-ignore lint/suspicious/noBitwiseOperators: Preserve the deterministic 32-bit hash used for map placement and colors.
    h = Math.imul(h ^ c.charCodeAt(0), 16_777_619);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Preserve the deterministic 32-bit hash used for map placement and colors.
  return (h >>> 0) / 4_294_967_296;
}

/** The padding an island keeps around its coast when islands are spaced, as `landmassHull` pads it. */
const shorePadding = 32;
/** Open sea kept beyond the outermost islands when the chart's extent is measured. */
const chartMargin = 120;
/**
 * Further sea below the southernmost islands keeps the composition clear of
 * the legend in the lower right.
 */
const footSea = 160;

/** How far an island's padded coast reaches from its centre; its footprint radius before it has a coast. */
export function reach(territory: IslandGeometry): number {
  const points = territory.coast.flatMap((polygon) => polygon[0] ?? []);
  const farthest = points.length
    ? Math.max(...points.map(([x = 0, y = 0]) => Math.hypot(x, y)))
    : territory.radius;
  return farthest + shorePadding;
}

/** Original dependency-pulled geography, with soft layer anchors and two-dimensional separation. */
export function settlePackages(
  regions: IslandGeometry[],
  layers: Readonly<Record<string, number | null>>,
  clearance: number,
  routes: { from: string; to: string; weight: number }[] = [],
  foundations: readonly DependencyFoundation[] = [],
  foundationInfluence = 1
): void {
  for (const region of regions) {
    region.x =
      (unit(region.id.slice(region.id.lastIndexOf(":") + 1)) - 0.5) * 1400;
    region.y = latitude(layers[region.id] ?? 0);
  }
  const ids = new Set(regions.map((region) => region.id));
  const connected = new Set(
    routes.flatMap((route) =>
      route.weight > 0 &&
      route.from !== route.to &&
      ids.has(route.from) &&
      ids.has(route.to)
        ? [route.from, route.to]
        : []
    )
  );
  const field = createFoundationAttraction(
    foundations,
    regions,
    foundationInfluence
  );
  const active = regions.filter((region) => connected.has(region.id));
  if (field.connected.size) {
    active.sort((a, b) => a.id.localeCompare(b.id));
  }
  const edges = field.connected.size
    ? [...routes].sort(
        (a, b) =>
          a.from.localeCompare(b.from) ||
          a.to.localeCompare(b.to) ||
          a.weight - b.weight
      )
    : routes;
  const byId = new Map(active.map((p) => [p.id, p]));
  for (let step = 0; step < 450; step += 1) {
    for (const a of active) {
      a.y += (latitude(layers[a.id] ?? 0) - a.y) * 0.018;
      a.x *= 0.999;
    }
    pullRoutes(edges, byId);
    settlePackagesEntries(active, clearance);
  }
  placeOffshoreIslands(regions, connected, clearance);
  if (field.connected.size) {
    refineFoundationLayout(regions, foundations, foundationInfluence);
  }
  // Translation preserves the original composition while fitting the current viewport.
  if (regions.length) {
    const [x, y] = middleOf(regions, reach);
    for (const region of regions) {
      region.x -= x;
      region.y -= y;
    }
  }
}

function pullRoutes(
  routes: { from: string; to: string; weight: number }[],
  islands: ReadonlyMap<string, IslandGeometry>
): void {
  for (const edge of routes) {
    const a = islands.get(edge.from);
    const b = islands.get(edge.to);
    if (!(a && b)) {
      continue;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy) || 1;
    const spring = (distance - a.radius - b.radius - 75) / distance;
    const pull = spring * 0.003 * attraction(edge.weight);
    a.x += dx * pull;
    a.y += dy * pull;
    b.x -= dx * pull;
    b.y -= dy * pull;
  }
}

/** Refine the established map without replacing its spacing or layer structure. */
function refineFoundationLayout(
  regions: IslandGeometry[],
  foundations: readonly DependencyFoundation[],
  influence: number
): void {
  const ordered = [...regions].sort((a, b) => a.id.localeCompare(b.id));
  const origins = ordered.map((island) => ({
    island,
    x: island.x,
    y: island.y,
  }));
  const field = createFoundationAttraction(foundations, ordered, influence);
  const separate = createCoastSeparation(ordered, 8);
  for (let step = 0; step < 450; step += 1) {
    // Original positions resist aggregate collapse when many groups overlap.
    for (const { island, x, y } of origins) {
      island.x += (x - island.x) * 0.008;
      island.y += (y - island.y) * 0.008;
    }
    field.apply();
    separate();
  }
  finishCoastSeparation(ordered, 8);
}

function finishCoastSeparation(regions: IslandGeometry[], gap: number): void {
  const separate = createCoastSeparation(
    [...regions].sort((a, b) => a.id.localeCompare(b.id)),
    gap
  );
  for (let step = 0; step < 250 && separate() > 0.001; step += 1) {
    // Finish separation after attraction stops.
  }
}

/** Unconnected islands follow an irregular orbit outside the connected islands' coasts. */
function placeOffshoreIslands(
  regions: IslandGeometry[],
  connected: ReadonlySet<string>,
  clearance: number
): void {
  const placed = regions.filter((region) => connected.has(region.id));
  const offshore = regions.filter((region) => !connected.has(region.id));
  const cx = placed.length
    ? (Math.min(...placed.map((region) => region.x - reach(region))) +
        Math.max(...placed.map((region) => region.x + reach(region)))) /
      2
    : 0;
  const cy = placed.length
    ? (Math.min(...placed.map((region) => region.y - reach(region))) +
        Math.max(...placed.map((region) => region.y + reach(region)))) /
      2
    : 0;
  const angles: number[] = [];
  const turn = Math.PI * (3 - Math.sqrt(5));
  const angularGap = Math.min(
    Math.PI / 4,
    (Math.PI * 1.3) / (offshore.length + 1)
  );
  for (const region of offshore.sort((a, b) => a.id.localeCompare(b.id))) {
    const id = region.id.slice(region.id.lastIndexOf(":") + 1);
    let angle = unit(`${id}:offshore-angle`) * Math.PI * 2;
    for (let attempt = 0; attempt <= offshore.length * 2; attempt += 1) {
      if (
        angles.every(
          (other) =>
            Math.abs(
              Math.atan2(Math.sin(angle - other), Math.cos(angle - other))
            ) >= angularGap
        )
      ) {
        break;
      }
      angle = (angle + turn) % (Math.PI * 2);
    }
    angles.push(angle);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const gap = clearance + 10;
    let distance = reach(region) + gap;
    for (const other of placed) {
      const dx = other.x - cx;
      const dy = other.y - cy;
      const along = dx * ux + dy * uy;
      const across = dx * uy - dy * ux;
      const separation = reach(region) + reach(other) + gap;
      if (Math.abs(across) < separation) {
        distance = Math.max(
          distance,
          along + Math.sqrt(separation ** 2 - across ** 2)
        );
      }
    }
    // Seeded extra water breaks a perfect ring without changing on each load.
    distance += 18 + unit(`${id}:offshore-distance`) * 42;
    region.x = cx + ux * distance;
    region.y = cy + uy * distance;
    placed.push(region);
  }
}

function settlePackagesEntries(regions: IslandGeometry[], clearance: number) {
  for (const [i, a] of regions.entries()) {
    for (const b of regions.slice(i + 1)) {
      const dx = b.x - a.x || 0.01;
      const dy = b.y - a.y || 0.01;
      const d = Math.hypot(dx, dy);
      const overlap = a.radius + b.radius + clearance + 10 - d;
      if (overlap <= 0) {
        continue;
      }
      const push = (overlap / d) * 0.48;
      a.x -= dx * push;
      a.y -= dy * push;
      b.x += dx * push;
      b.y += dy * push;
    }
  }
}

/**
 * The middle of the islands' padded extent, with `footSea` below it: the
 * offset that centres them on the origin, as the chart is.
 */
export function middleOf(
  territories: readonly IslandGeometry[],
  reachOf: (territory: IslandGeometry) => number
): [number, number] {
  const west = Math.min(...territories.map((p) => p.x - reachOf(p)));
  const east = Math.max(...territories.map((p) => p.x + reachOf(p)));
  const north = Math.min(...territories.map((p) => p.y - reachOf(p)));
  const south = Math.max(...territories.map((p) => p.y + reachOf(p))) + footSea;
  return [(west + east) / 2, (north + south) / 2];
}

/** The chart's extent: symmetric about the origin, with open sea beyond the outermost islands. */
export function chartSize(territories: readonly IslandGeometry[]) {
  return {
    height:
      2 *
      (Math.max(0, ...territories.map((p) => Math.abs(p.y) + p.radius)) +
        chartMargin),
    width:
      2 *
      (Math.max(0, ...territories.map((p) => Math.abs(p.x) + p.radius)) +
        chartMargin),
  };
}
