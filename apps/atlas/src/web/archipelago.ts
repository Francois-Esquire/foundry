import { landmassHull } from "./landmass-hull";
import type { AtlasData } from "./types";

type Point = [number, number];

export function archipelagoHull(data: AtlasData): Point[] {
  return landmassHull(data.territories, 90);
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
  ring = ring.flatMap((p, i) => {
    const next = ring[(i + 1) % ring.length] ?? p;
    const count = Math.max(
      1,
      Math.ceil(Math.hypot(next[0] - p[0], next[1] - p[1]) / 20)
    );
    return Array.from(
      { length: count },
      (_, n): Point => [
        p[0] + ((next[0] - p[0]) * n) / count,
        p[1] + ((next[1] - p[1]) * n) / count,
      ]
    );
  });
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
