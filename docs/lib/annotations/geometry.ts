import type { Point } from "./model.ts";

/** Fit a stroke within the reading column without changing its saved geometry. */
export function fitStroke(
  points: Point[],
  origin: Point,
  width: number
): Point[] {
  const min = Math.min(0, ...points.map((point) => point.x));
  const max = Math.max(0, ...points.map((point) => point.x));
  const scale = Math.min(1, Math.max(1, width - 16) / Math.max(1, max - min));
  const left = 8 - min * scale;
  const right = width - 8 - max * scale;
  const x = Math.max(left, Math.min(origin.x, right));
  return points.map((point) => ({
    x: x + point.x * scale,
    y: origin.y + point.y * scale,
  }));
}
