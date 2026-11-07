/**
 * The terrain's height at a chart point, worked out on the CPU from the
 * chart's coasts, for what sits on the land outside the GPU (DOM labels):
 * on land, the land's profile (land.wgsl `landHeight`) at the distance
 * inland of the coast, as the height map bakes it; at sea, an
 * approximation, since the sea floor's bathymetry lives only in the GPU's
 * height map.
 *
 * Two departures from the height map, both small: the rim's distance is
 * the exact one, without the height map's `rimSmoothing` ease over the
 * first few units inland, and the coast's own height is sea level where
 * the height map takes the sea floor's height at the coast (a beach's
 * crest, a little above it). On Foundry's chart the land agrees with the
 * height map to 0.03 units at the median and 1.2 at worst.
 *
 * At sea it gives a fall from sea level at the coast to the top bank's
 * depth (sea-params.ts `seaDepthsOf`) over `bankBeach`, and that depth
 * beyond. The banks' lower plates, the platform and the deep are not
 * modelled, so past the beach this is the shallowest the floor stands,
 * not where it is: the height map's floor lies that deep or deeper (on
 * Foundry's chart, 10 to 78 units deeper).
 *
 * Pure, no GPU.
 */
import type { Chart, Point, Ring } from "../../../data/chart";
import {
  type Bounds,
  polygonBounds,
  polygonContains,
} from "../../../data/geometry";
import type { MapParams } from "../maps/map-params";

/** The settings the height follows: the land's profile, the beach's width, and the top bank's depth. */
export type HeightRules = Pick<
  MapParams,
  | "bankBeach"
  | "crownHeight"
  | "crownWidth"
  | "lipHeight"
  | "lipWidth"
  | "plateHeight"
  | "rimWidth"
> & {
  /** The top bank's depth below sea level, chart units (`seaDepthsOf(…).top`). */
  seaTop: number;
};

interface Piece {
  bounds: Bounds;
  polygon: Chart["islands"][number]["shape"]["coast"][number];
  rings: readonly Ring[];
}

const piecesOf = new WeakMap<Chart, readonly Piece[]>();

/** Every coast polygon of the chart with its box, kept per chart. */
function pieces(chart: Chart): readonly Piece[] {
  const cached = piecesOf.get(chart);
  if (cached) {
    return cached;
  }
  const made = chart.islands.flatMap((island) =>
    island.shape.coast.map((polygon) => ({
      bounds: polygonBounds(polygon),
      polygon,
      rings: [polygon.outer, ...polygon.holes],
    }))
  );
  piecesOf.set(chart, made);
  return made;
}

/** How far `p` lies from a closed ring's nearest edge. */
function ringDistance(ring: Ring, [x, y]: Point): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const [index, [x0, y0]] of ring.entries()) {
    const [x1, y1] = ring[(index + 1) % ring.length] ?? [x0, y0];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = dx * dx + dy * dy;
    const t =
      length > 0
        ? Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / length))
        : 0;
    nearest = Math.min(
      nearest,
      Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy))
    );
  }
  return nearest;
}

/** How far `p` lies from a box, 0 inside it. */
const boxDistance = (box: Bounds, [x, y]: Point) =>
  Math.hypot(
    Math.max(box.minX - x, 0, x - box.maxX),
    Math.max(box.minY - y, 0, y - box.maxY)
  );

/** land.wgsl and frame.wgsl `ease`: a smoothstep, a step when the band is empty. */
function ease(start: number, end: number, x: number): number {
  if (end <= start) {
    return x >= start ? 1 : 0;
  }
  const t = Math.min(1, Math.max(0, (x - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

/** land.wgsl `landHeight` at `inland` of the coast, the coast at sea level. */
export function landHeight(rules: HeightRules, inland: number): number {
  const {
    crownHeight,
    crownWidth,
    lipHeight,
    lipWidth,
    plateHeight,
    rimWidth,
  } = rules;
  const rise = ease(0, rimWidth, inland);
  const lip = rise * (1 - ease(rimWidth, rimWidth + lipWidth, inland));
  const crown =
    crownHeight *
    rise *
    (1 - Math.exp(-Math.max(inland, 0) / Math.max(crownWidth, 1e-3)));
  return plateHeight * rise + lipHeight * lip + crown;
}

/** bathymetry.wgsl `fall`: from sea level to `floor`, `t` of the way out, steepest at the water's edge. */
const fall = (floor: number, t: number) => {
  const rest = 1 - Math.min(1, Math.max(0, t));
  return floor * (1 - rest * rest);
};

/**
 * The terrain's height at a chart point, chart units above sea level
 * (negative under it), as world `y` for `project`.
 */
export function heightAt(
  chart: Chart,
  rules: HeightRules,
  point: Point
): number {
  const all = pieces(chart);
  let inland = Number.NEGATIVE_INFINITY;
  for (const piece of all) {
    if (boxDistance(piece.bounds, point) > 0) {
      continue;
    }
    if (polygonContains(piece.polygon, point)) {
      const within = Math.min(
        ...piece.rings.map((ring) => ringDistance(ring, point))
      );
      inland = Math.max(inland, within);
    }
  }
  if (inland > Number.NEGATIVE_INFINITY) {
    return landHeight(rules, inland);
  }
  const beach = Math.max(rules.bankBeach, 1e-3);
  let offshore = Number.POSITIVE_INFINITY;
  for (const piece of all) {
    if (boxDistance(piece.bounds, point) < Math.min(offshore, beach)) {
      for (const ring of piece.rings) {
        offshore = Math.min(offshore, ringDistance(ring, point));
      }
    }
  }
  return fall(-Math.max(rules.seaTop, 0), offshore / beach);
}
