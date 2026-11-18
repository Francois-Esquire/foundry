import type { Chart, Point, Ring } from "../../../data/chart";
import {
  type Bounds,
  polygonBounds,
  polygonContains,
} from "../../../data/geometry";
import type { MapParams } from "../maps/map-params";

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
  seaTop: number;
};

interface Piece {
  bounds: Bounds;
  polygon: Chart["islands"][number]["shape"]["coast"][number];
  rings: readonly Ring[];
}

const piecesOf = new WeakMap<Chart, readonly Piece[]>();

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

const boxDistance = (box: Bounds, [x, y]: Point) =>
  Math.hypot(
    Math.max(box.minX - x, 0, x - box.maxX),
    Math.max(box.minY - y, 0, y - box.maxY)
  );

function ease(start: number, end: number, x: number): number {
  if (end <= start) {
    return x >= start ? 1 : 0;
  }
  const t = Math.min(1, Math.max(0, (x - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

function landHeight(rules: HeightRules, inland: number): number {
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

const fall = (floor: number, t: number) => {
  const rest = 1 - Math.min(1, Math.max(0, t));
  return floor * (1 - rest * rest);
};

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
