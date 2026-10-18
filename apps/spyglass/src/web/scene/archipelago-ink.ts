import { archipelagoCurve } from "../layout/archipelago";

type Point = [number, number];

/** Traces a rim's Bezier curve as one closed path on `ctx`; the caller strokes or fills it. */
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
