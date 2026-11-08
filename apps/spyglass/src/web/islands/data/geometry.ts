/**
 * Ring and polygon helpers for the chart: pure functions over plain points.
 *
 * Orientation is the shoelace sign in the chart's own axes: a ring is
 * counter-clockwise when its signed area is positive, that is when it turns
 * from +x toward +y. Chart `y` runs south, so on a page drawn y-down such a
 * ring looks clockwise; the sign, not the look, is the convention.
 */
import type { Chart, Point, Polygon, Ring } from "./chart";

/** An axis-aligned box in chart units. */
export interface Bounds {
  readonly maxX: number;
  readonly maxY: number;
  readonly minX: number;
  readonly minY: number;
}

/**
 * Below this share of its bounding box's area a ring counts as having no
 * area: its points are collinear but for rounding.
 */
const FLAT_RING_SHARE = 1e-9;

const MIN_RING_POINTS = 3;

const isFinitePoint = (p: Point): boolean =>
  Number.isFinite(p[0]) && Number.isFinite(p[1]);

const samePoint = (a: Point, b: Point): boolean =>
  a[0] === b[0] && a[1] === b[1];

/** Signed area: positive counter-clockwise in chart space (see above). */
function ringArea(ring: Ring): number {
  let twice = 0;
  for (const [index, [x0, y0]] of ring.entries()) {
    const [x1, y1] = ring[(index + 1) % ring.length] ?? [x0, y0];
    twice += x0 * y1 - x1 * y0;
  }
  return twice / 2;
}

/** The box around a set of points, or null for none. */
function pointsBounds(points: Iterable<Point>): Bounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return minX <= maxX ? { maxX, maxY, minX, minY } : null;
}

/**
 * A ring fit for the chart, or null if nothing usable is left: non-finite
 * points dropped, consecutive repeats collapsed, the closing point (a repeat
 * of the first) dropped. Fewer than three points, or no area to speak of,
 * is not a ring: neither can be oriented or filled. Orientation is kept.
 */
export function cleanRing(points: readonly Point[]): Ring | null {
  const kept: Point[] = [];
  for (const p of points) {
    const last = kept.at(-1);
    if (isFinitePoint(p) && !(last && samePoint(last, p))) {
      kept.push([p[0], p[1]]);
    }
  }
  // Popping from the end leaves the first point where it is.
  const [first] = kept;
  while (first && kept.length > 1 && samePoint(first, kept.at(-1) ?? first)) {
    kept.pop();
  }
  if (kept.length < MIN_RING_POINTS) {
    return null;
  }
  const box = pointsBounds(kept);
  const boxArea = box ? (box.maxX - box.minX) * (box.maxY - box.minY) : 0;
  return Math.abs(ringArea(kept)) > boxArea * FLAT_RING_SHARE ? kept : null;
}

/** The ring turning the asked way: reversed if it does not already. */
function orientRing(ring: Ring, counterClockwise: boolean): Ring {
  return ringArea(ring) > 0 === counterClockwise ? ring : [...ring].reverse();
}

/** Outer ring counter-clockwise, holes clockwise. */
export function orientPolygon(polygon: Polygon): Polygon {
  return {
    holes: polygon.holes.map((hole) => orientRing(hole, false)),
    outer: orientRing(polygon.outer, true),
  };
}

/** Whether a horizontal ray from `p` crosses `ring` an odd number of times. */
function ringEncloses(ring: Ring, [x, y]: Point): boolean {
  let inside = false;
  for (const [index, [x0, y0]] of ring.entries()) {
    const [x1, y1] = ring[(index + 1) % ring.length] ?? [x0, y0];
    if (y0 > y !== y1 > y && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Whether `p` lies on a polygon's land: inside its outer ring, outside its holes. */
export function polygonContains(polygon: Polygon, p: Point): boolean {
  return (
    ringEncloses(polygon.outer, p) &&
    !polygon.holes.some((hole) => ringEncloses(hole, p))
  );
}

/** The box around a polygon's outer ring and holes. */
export function polygonBounds(polygon: Polygon): Bounds {
  const box = pointsBounds([polygon.outer, ...polygon.holes].flat());
  if (!box) {
    throw new Error("polygonBounds: a polygon's outer ring has no points");
  }
  return box;
}

/** The smallest box holding both. */
function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
  };
}

/** The box of the chart's extent, centred on the origin. */
function extentBounds(chart: Pick<Chart, "extent">): Bounds {
  const { height, width } = chart.extent;
  return {
    maxX: width / 2,
    maxY: height / 2,
    minX: -width / 2,
    minY: -height / 2,
  };
}

/**
 * The box around every island's coast: where the land is. A chart with no
 * islands has no land, and its bounds are its extent.
 */
export function chartBounds(chart: Pick<Chart, "extent" | "islands">): Bounds {
  let bounds: Bounds | null = null;
  for (const island of chart.islands) {
    for (const polygon of island.shape.coast) {
      const box = polygonBounds(polygon);
      bounds = bounds ? unionBounds(bounds, box) : box;
    }
  }
  return bounds ?? extentBounds(chart);
}
