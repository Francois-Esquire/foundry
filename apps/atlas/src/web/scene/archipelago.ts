import { landmassHull } from "../landmass-hull";
import type { AtlasData } from "../types";

type Point = [number, number];

/** Angular samples around the rim. */
const rimSamples = 180;
/** Samples each side for the outward (maximum) and smoothing passes. */
const rimWindow = 9;

/**
 * The archipelago's outer rim: a padded hull around every island, smoothed in
 * polar form about its centre. A moving maximum of the radius only moves the
 * rim outward, then a triangular moving average of that maximum bends long
 * straight sides into broad arcs. Each averaged radius covers the hull's own
 * radius at that angle, so the smooth rim always contains the padded hull.
 */
export function archipelagoHull(data: AtlasData): Point[] {
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

export function traceArchipelago(
  ctx: CanvasRenderingContext2D,
  ring: Point[]
): void {
  ctx.beginPath();
  for (const [i, curve] of archipelagoCurve(ring).entries()) {
    if (!i) {
      ctx.moveTo(...curve.start);
    }
    ctx.bezierCurveTo(...curve.first, ...curve.second, ...curve.end);
  }
  ctx.closePath();
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
