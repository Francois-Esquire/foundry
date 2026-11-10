/** Turns curved contours into polygons, and measures polygons. */
import type { Contour, Outline, Point, Segment } from "~/typeface/outline";

const MAX_STEPS = 64;

const quadraticPoint = (
  from: Point,
  control: Point,
  to: Point,
  t: number
): Point => {
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
  };
};

const cubicPoint = (
  from: Point,
  c1: Point,
  c2: Point,
  to: Point,
  t: number
): Point => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * from.x + b * c1.x + c * c2.x + d * to.x,
    y: a * from.y + b * c1.y + c * c2.y + d * to.y,
  };
};

/** How far a control point strays from the chord decides how many steps a curve needs. */
const stepsFor = (deviation: number, tolerance: number) =>
  Math.min(
    MAX_STEPS,
    Math.max(1, Math.ceil(Math.sqrt(deviation / Math.max(tolerance, 1e-6))))
  );

const flattenSegment = (
  from: Point,
  segment: Segment,
  tolerance: number,
  into: Point[]
) => {
  if (segment.kind === "line") {
    into.push(segment.to);
    return;
  }
  if (segment.kind === "quadratic") {
    const { control, to } = segment;
    const deviation =
      Math.hypot(from.x - 2 * control.x + to.x, from.y - 2 * control.y + to.y) /
      4;
    const steps = stepsFor(deviation, tolerance);
    for (let step = 1; step <= steps; step += 1) {
      into.push(quadraticPoint(from, control, to, step / steps));
    }
    return;
  }
  const { control1, control2, to } = segment;
  const deviation =
    (3 / 4) *
    Math.max(
      Math.hypot(
        from.x - 2 * control1.x + control2.x,
        from.y - 2 * control1.y + control2.y
      ),
      Math.hypot(
        control1.x - 2 * control2.x + to.x,
        control1.y - 2 * control2.y + to.y
      )
    );
  const steps = stepsFor(deviation, tolerance);
  for (let step = 1; step <= steps; step += 1) {
    into.push(cubicPoint(from, control1, control2, to, step / steps));
  }
};

/**
 * A closed polygon that stays within `tolerance` of the contour. The first
 * point is not repeated at the end.
 */
export const flattenContour = (
  contour: Contour,
  tolerance: number
): Point[] => {
  const polygon: Point[] = [contour.start];
  let from = contour.start;
  for (const segment of contour.segments) {
    flattenSegment(from, segment, tolerance, polygon);
    from = segment.to;
  }
  const last = polygon.at(-1);
  if (
    polygon.length > 1 &&
    last &&
    last.x === contour.start.x &&
    last.y === contour.start.y
  ) {
    polygon.pop();
  }
  return polygon;
};

export const flattenOutline = (
  outline: Outline,
  tolerance: number
): Point[][] =>
  outline.contours.map((contour) => flattenContour(contour, tolerance));

/** Positive for a counter-clockwise polygon when y points up. */
export const signedArea = (polygon: readonly Point[]): number => {
  let doubled = 0;
  let previous = polygon.at(-1);
  for (const point of polygon) {
    if (previous) {
      doubled += previous.x * point.y - point.x * previous.y;
    }
    previous = point;
  }
  return doubled / 2;
};

export const polygonLength = (polygon: readonly Point[]): number => {
  let length = 0;
  let previous = polygon.at(-1);
  for (const point of polygon) {
    if (previous) {
      length += Math.hypot(point.x - previous.x, point.y - previous.y);
    }
    previous = point;
  }
  return length;
};

/** Whether a point lies inside a polygon, by the even-odd rule. */
export const polygonContains = (
  polygon: readonly Point[],
  point: Point
): boolean => {
  let inside = false;
  let previous = polygon.at(-1);
  for (const current of polygon) {
    if (
      previous &&
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
          current.x
    ) {
      inside = !inside;
    }
    previous = current;
  }
  return inside;
};
