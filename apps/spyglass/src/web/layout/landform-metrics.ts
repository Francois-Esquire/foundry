import { shoreDistances } from "../../lib/visualization/distance-field";
import {
  classifyLandform,
  defaultLandformSettings,
  type IslandLandform,
  type LandformMetrics,
  type LandformOutlet,
  type LandformParams,
  type LandformSettings,
} from "../../lib/visualization/landforms";
import { fillPolygon } from "../../lib/visualization/scanline-fill";
import type { SpyglassData, Territory } from "../data/types";

/**
 * Reads what a package's island is classified from, and the geometry its
 * landform is built over, from the settled layout. Coasts and files are in
 * island units around the island's position; the geometry is handed on in
 * map positions, as a landform is sampled.
 */
export const defaultLandformMetricsSettings = {
  /** Map units per cell of the raster an island's depth is measured on. */
  cell: 2,
  /**
   * Bays handed to a landform as drainage outlets: at most `most`, each at
   * least `depth` map units in from the coast's convex hull and `spacing`
   * map units from a deeper one.
   */
  outlets: { depth: 6, most: 6, spacing: 28 },
  /** The most hubs handed to a landform as peaks, strongest first. */
  peaks: 8,
};
export type LandformMetricsSettings = typeof defaultLandformMetricsSettings;

type Ring = readonly (readonly [number, number])[];

/** Area, first and second moments of one ring, signed by its winding. */
function ringMoments(ring: Ring) {
  let area = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x0, y0] = ring[index] ?? [0, 0];
    const [x1, y1] = ring[(index + 1) % ring.length] ?? [0, 0];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    sx += (x0 + x1) * cross;
    sy += (y0 + y1) * cross;
    sxx += (x0 * x0 + x0 * x1 + x1 * x1) * cross;
    syy += (y0 * y0 + y0 * y1 + y1 * y1) * cross;
    sxy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cross;
  }
  return {
    area: area / 2,
    sx: sx / 6,
    sxx: sxx / 12,
    sxy: sxy / 24,
    sy: sy / 6,
    syy: syy / 12,
  };
}

/**
 * The land's centre of area and its principal axes, holes taken out: the
 * axis, and half its length and breadth as an ellipse of the same second
 * moments would have them.
 */
function landShape(territory: Territory) {
  const total = { area: 0, sx: 0, sxx: 0, sxy: 0, sy: 0, syy: 0 };
  for (const polygon of territory.coast) {
    for (const [index, ring] of polygon.entries()) {
      const moments = ringMoments(ring);
      const sign = (index === 0 ? 1 : -1) * Math.sign(moments.area || 1);
      total.area += sign * moments.area;
      total.sx += sign * moments.sx;
      total.sy += sign * moments.sy;
      total.sxx += sign * moments.sxx;
      total.syy += sign * moments.syy;
      total.sxy += sign * moments.sxy;
    }
  }
  if (total.area <= 0) {
    const radius = Math.max(1, territory.radius);
    return {
      axis: [1, 0] as const,
      breadth: radius,
      length: radius,
      x: 0,
      y: 0,
    };
  }
  const x = total.sx / total.area;
  const y = total.sy / total.area;
  const xx = total.sxx / total.area - x * x;
  const yy = total.syy / total.area - y * y;
  const xy = total.sxy / total.area - x * y;
  const mean = (xx + yy) / 2;
  const spread = Math.sqrt(Math.max(0, ((xx - yy) / 2) ** 2 + xy * xy));
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  return {
    axis: [Math.cos(angle), Math.sin(angle)] as const,
    breadth: 2 * Math.sqrt(Math.max(0, mean - spread)),
    length: 2 * Math.sqrt(mean + spread),
    x,
    y,
  };
}

/** Map units inland of the island's deepest point, measured on a raster of its coast. */
function landDepth(territory: Territory, cell: number): number {
  const points = territory.coast.flat(2);
  if (points.length === 0) {
    return Math.max(1, territory.radius);
  }
  const left = Math.min(...points.map(([x]) => x)) - 2 * cell;
  const top = Math.min(...points.map(([, y]) => y)) - 2 * cell;
  const width =
    Math.ceil((Math.max(...points.map(([x]) => x)) - left) / cell) + 2;
  const height =
    Math.ceil((Math.max(...points.map(([, y]) => y)) - top) / cell) + 2;
  const land = new Uint8Array(width * height);
  for (const polygon of territory.coast) {
    fillPolygon(
      land,
      width,
      height,
      polygon.map((ring) =>
        ring.map(([x, y]) => [(x - left) / cell, (y - top) / cell] as const)
      )
    );
  }
  const water = land.map((value) => 1 - value);
  const distances = shoreDistances(water, width, height);
  let deepest = 0;
  for (const [index, distance] of distances.entries()) {
    if (land[index]) {
      deepest = Math.max(deepest, distance);
    }
  }
  return Math.max(1, deepest * cell);
}

type Point = readonly [number, number];

/** The convex hull of a ring's points, anticlockwise, by the monotone chain. */
function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort(([ax, ay], [bx, by]) => ax - bx || ay - by);
  const cross = (o: Point, a: Point, b: Point) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (ordered: readonly Point[]) => {
    const chain: Point[] = [];
    for (const point of ordered) {
      while (chain.length >= 2) {
        const a = chain.at(-2);
        const b = chain.at(-1);
        if (!(a && b) || cross(a, b, point) > 0) {
          break;
        }
        chain.pop();
      }
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** A point's distance to a closed polygon's boundary. */
function boundaryDistance(point: Point, polygon: readonly Point[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const [index, a] of polygon.entries()) {
    const b = polygon[(index + 1) % polygon.length] ?? a;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const span = dx * dx + dy * dy;
    const t =
      span > 0
        ? Math.min(
            1,
            Math.max(
              0,
              ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / span
            )
          )
        : 0;
    nearest = Math.min(
      nearest,
      Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy)
    );
  }
  return nearest;
}

/**
 * The heads of the coast's bays, in map positions, deepest first: the coast
 * points furthest in from the convex hull of their piece's outer ring, at
 * least `depth` map units in and `spacing` apart.
 */
function bayOutlets(
  territory: Territory,
  settings: LandformMetricsSettings["outlets"]
): LandformOutlet[] {
  const candidates = territory.coast.flatMap(([outer]) => {
    if (!outer || outer.length < 4) {
      return [];
    }
    const hull = convexHull(outer);
    return outer.map((point) => ({
      depth: boundaryDistance(point, hull),
      x: territory.x + point[0],
      y: territory.y + point[1],
    }));
  });
  const outlets: LandformOutlet[] = [];
  for (const candidate of candidates
    .filter((point) => point.depth >= settings.depth)
    .sort((a, b) => b.depth - a.depth || a.x - b.x || a.y - b.y)) {
    if (outlets.length >= settings.most) {
      break;
    }
    if (
      outlets.every(
        (outlet) =>
          Math.hypot(outlet.x - candidate.x, outlet.y - candidate.y) >=
          settings.spacing
      )
    ) {
      outlets.push(candidate);
    }
  }
  return outlets;
}

function centre(files: readonly { x: number; y: number }[]) {
  const count = Math.max(1, files.length);
  return {
    x: files.reduce((sum, file) => sum + file.x, 0) / count,
    y: files.reduce((sum, file) => sum + file.y, 0) / count,
  };
}

function meanDistance(
  files: readonly { x: number; y: number }[],
  from: { x: number; y: number }
): number {
  return (
    files.reduce(
      (sum, file) => sum + Math.hypot(file.x - from.x, file.y - from.y),
      0
    ) / Math.max(1, files.length)
  );
}

/** What a package's island is classified from. */
export function landformMetrics(territory: Territory): LandformMetrics {
  const { files } = territory;
  const hubs = files.filter((file) => file.highFanIn);
  const fanIn = files.map((file) => file.internalFanIn).sort((a, b) => b - a);
  const [first = 0, second = 0] = fanIn;
  const shape = landShape(territory);
  const middle = centre(files);
  const spread = meanDistance(files, middle);
  return {
    coastPieces: territory.coast.length,
    elongation: shape.breadth > 0 ? shape.length / shape.breadth : 1,
    files: files.length,
    hubDominance: first > 0 ? first / Math.max(1, second) : 1,
    hubRim: hubs.length && spread > 0 ? meanDistance(hubs, middle) / spread : 0,
    hubs: hubs.length,
  };
}

/** The geometry a package's landform is built over, in map positions. */
export function landformParams(
  territory: Territory,
  settings: LandformMetricsSettings = defaultLandformMetricsSettings
): LandformParams {
  const shape = landShape(territory);
  const hubs = territory.files
    .filter((file) => file.highFanIn)
    .sort(
      (a, b) => b.internalFanIn - a.internalFanIn || a.id.localeCompare(b.id)
    )
    .slice(0, settings.peaks);
  const strongest = Math.max(1, hubs[0]?.internalFanIn ?? 0);
  return {
    axis: shape.axis,
    breadth: shape.breadth,
    depth: landDepth(territory, settings.cell),
    length: shape.length,
    outlets: bayOutlets(territory, settings.outlets),
    peaks: hubs.map((file) => ({
      weight: file.internalFanIn / strongest,
      x: territory.x + file.x,
      y: territory.y + file.y,
    })),
    x: territory.x + shape.x,
    y: territory.y + shape.y,
  };
}

/** Every island's formation and geometry, by island id, ready for `landformFor`. */
export function islandLandforms(
  data: Pick<SpyglassData, "territories">,
  settings: LandformMetricsSettings = defaultLandformMetricsSettings,
  landformSettings: LandformSettings = defaultLandformSettings
): Map<string, IslandLandform> {
  return new Map(
    data.territories.map((territory) => [
      territory.id,
      {
        archetype: classifyLandform(
          landformMetrics(territory),
          landformSettings
        ),
        params: landformParams(territory, settings),
      },
    ])
  );
}
