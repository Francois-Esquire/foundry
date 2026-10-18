import { islandsByFrame, type SpyglassData } from "../data/types";
import { landmassHull } from "./landmass-hull";

type Point = [number, number];

/** Angular samples around the rim. */
const rimSamples = 180;
/** Samples each side for the outward (maximum) and smoothing passes. */
const rimWindow = 9;

/**
 * An archipelago's outer rim: a padded hull around every island given,
 * smoothed in polar form about its centre. A moving maximum of the radius
 * only moves the rim outward, then a triangular moving average of that
 * maximum bends long straight sides into broad arcs. Each averaged radius
 * covers the hull's own radius at that angle, so the smooth rim always
 * contains the padded hull. It moves with its islands: moved together, they
 * give the same rim, moved.
 */
export function archipelagoHull(
  data: Pick<SpyglassData, "territories">
): Point[] {
  const hull = landmassHull(data.territories, 110);
  if (hull.length < 3) {
    return hull;
  }
  const cx = hull.reduce((sum, [x]) => sum + x, 0) / hull.length;
  const cy = hull.reduce((sum, [, y]) => sum + y, 0) / hull.length;
  const angle = (i: number) => (i / rimSamples) * Math.PI * 2;
  const radii = Array.from({ length: rimSamples }, (_, i) =>
    rayExit(hull, cx, cy, angle(i))
  );
  const around = (values: number[], i: number) =>
    values[(i + rimSamples) % rimSamples] ?? 0;
  const widest = radii.map((_, i) => {
    let radius = 0;
    for (let k = -rimWindow; k <= rimWindow; k += 1) {
      radius = Math.max(radius, around(radii, i + k));
    }
    return radius;
  });
  return widest.map((_, i) => {
    let total = 0;
    let weight = 0;
    for (let k = -rimWindow; k <= rimWindow; k += 1) {
      const w = rimWindow + 1 - Math.abs(k);
      total += around(widest, i + k) * w;
      weight += w;
    }
    const radius = total / weight;
    return [cx + radius * Math.cos(angle(i)), cy + radius * Math.sin(angle(i))];
  });
}

/**
 * One rim per frame: each workspace of a collection is its own archipelago,
 * set apart from the next by open water. A single workspace's one rim is
 * built from all its islands, as before frames.
 */
export function archipelagoRims(
  data: Pick<SpyglassData, "frames" | "territories">
): Point[][] {
  if (data.frames.length <= 1) {
    return [archipelagoHull(data)];
  }
  return islandsByFrame(data).map((territories) =>
    archipelagoHull({ territories })
  );
}

/** Distance from (cx, cy) along `theta` to where the ray leaves a convex ring. */
function rayExit(ring: Point[], cx: number, cy: number, theta: number) {
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);
  let exit = 0;
  for (const [i, a] of ring.entries()) {
    const b = ring[(i + 1) % ring.length] ?? a;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-9) {
      continue;
    }
    const t = ((a[0] - cx) * ey - (a[1] - cy) * ex) / denominator;
    const u = ((a[0] - cx) * dy - (a[1] - cy) * dx) / denominator;
    if (u >= 0 && u <= 1) {
      exit = Math.max(exit, t);
    }
  }
  return exit;
}

function resample(ring: Point[], spacing: number): Point[] {
  return ring.flatMap((p, i) => {
    const next = ring[(i + 1) % ring.length] ?? p;
    const count = Math.max(
      1,
      Math.round(Math.hypot(next[0] - p[0], next[1] - p[1]) / spacing)
    );
    return Array.from(
      { length: count },
      (_, n): Point => [
        p[0] + ((next[0] - p[0]) * n) / count,
        p[1] + ((next[1] - p[1]) * n) / count,
      ]
    );
  });
}

/**
 * The rim's Bezier curve as a closed polyline, sampled about every `spacing`
 * units along each curve, for a fill that cannot take curves. The rim bends
 * gently, so at a spacing under half a grid cell the polyline reaches every
 * cell the curve does.
 */
export function flattenArchipelago(ring: Point[], spacing: number): Point[] {
  const points: Point[] = [];
  for (const curve of archipelagoCurve(ring)) {
    const length =
      Math.hypot(
        curve.first[0] - curve.start[0],
        curve.first[1] - curve.start[1]
      ) +
      Math.hypot(
        curve.second[0] - curve.first[0],
        curve.second[1] - curve.first[1]
      ) +
      Math.hypot(
        curve.end[0] - curve.second[0],
        curve.end[1] - curve.second[1]
      );
    const steps = Math.max(1, Math.ceil(length / spacing));
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      const u = 1 - t;
      points.push([
        u ** 3 * curve.start[0] +
          3 * u ** 2 * t * curve.first[0] +
          3 * u * t ** 2 * curve.second[0] +
          t ** 3 * curve.end[0],
        u ** 3 * curve.start[1] +
          3 * u ** 2 * t * curve.first[1] +
          3 * u * t ** 2 * curve.second[1] +
          t ** 3 * curve.end[1],
      ]);
    }
  }
  return points;
}

export function archipelagoCurve(initialRing: Point[]) {
  let ring = initialRing;
  if (ring.length < 3) {
    return [];
  }
  ring = resample(ring, 20);
  return ring.map((p, i) => {
    const previous = ring[(i + ring.length - 1) % ring.length] ?? p;
    const next = ring[(i + 1) % ring.length] ?? p;
    const start: Point = [(previous[0] + p[0]) / 2, (previous[1] + p[1]) / 2];
    const end: Point = [(next[0] + p[0]) / 2, (next[1] + p[1]) / 2];
    const first: Point = [
      start[0] + ((p[0] - start[0]) * 2) / 3,
      start[1] + ((p[1] - start[1]) * 2) / 3,
    ];
    const second: Point = [
      end[0] + ((p[0] - end[0]) * 2) / 3,
      end[1] + ((p[1] - end[1]) * 2) / 3,
    ];
    return { end, first, second, start };
  });
}
