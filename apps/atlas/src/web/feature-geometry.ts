import type { FeaturePoint } from "./natural-features";

const epsilon = 1e-7;

/** Includes touching and collinear overlap, so a grid cannot jump a thin inlet. */
export function segmentIntersection(
  a: FeaturePoint,
  b: FeaturePoint,
  c: FeaturePoint,
  d: FeaturePoint
): FeaturePoint | undefined {
  if (
    Math.max(a.x, b.x) + epsilon < Math.min(c.x, d.x) ||
    Math.max(c.x, d.x) + epsilon < Math.min(a.x, b.x) ||
    Math.max(a.y, b.y) + epsilon < Math.min(c.y, d.y) ||
    Math.max(c.y, d.y) + epsilon < Math.min(a.y, b.y)
  ) {
    return undefined;
  }
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const ex = d.x - c.x,
    ey = d.y - c.y;
  const determinant = dx * ey - dy * ex;
  const cx = c.x - a.x,
    cy = c.y - a.y;
  if (Math.abs(determinant) < epsilon) {
    if (Math.abs(cx * dy - cy * dx) > epsilon) {
      return;
    }
    const squared = dx * dx + dy * dy;
    if (squared < epsilon) {
      return;
    }
    const t0 = (cx * dx + cy * dy) / squared;
    const t1 = t0 + (ex * dx + ey * dy) / squared;
    const low = Math.max(0, Math.min(t0, t1));
    const high = Math.min(1, Math.max(t0, t1));
    if (low > high + epsilon) {
      return;
    }
    const t = (low + high) / 2;
    return { x: a.x + t * dx, y: a.y + t * dy };
  }
  const t = (cx * ey - cy * ex) / determinant;
  const u = (cx * dy - cy * dx) / determinant;
  return t >= -epsilon && t <= 1 + epsilon && u >= -epsilon && u <= 1 + epsilon
    ? { x: a.x + t * dx, y: a.y + t * dy }
    : undefined;
}
