/**
 * Least-squares fitting of cubic curves to a run of points, after Philip J.
 * Schneider, "An Algorithm for Automatically Fitting Digitized Curves"
 * (Graphics Gems, 1990). A run that one curve cannot follow is split at its
 * worst point and each half is fitted again.
 */
import type { Point, Segment } from "~/typeface/outline";

type Cubic = readonly [Point, Point, Point, Point];

const REFITS = 4;
/** A run within this share of the tolerance of its chord is a straight line. */
const LINE_SHARE = 0.8;

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const subtract = (a: Point, b: Point): Point => ({
  x: a.x - b.x,
  y: a.y - b.y,
});
const scale = (a: Point, factor: number): Point => ({
  x: a.x * factor,
  y: a.y * factor,
});
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export const unit = (vector: Point): Point => {
  const length = Math.hypot(vector.x, vector.y);
  return length === 0 ? { x: 0, y: 0 } : scale(vector, 1 / length);
};

const at = (points: readonly Point[], index: number): Point =>
  points[index] ?? { x: 0, y: 0 };

const cubicAt = ([p0, p1, p2, p3]: Cubic, t: number): Point => {
  const u = 1 - t;
  return add(
    add(scale(p0, u * u * u), scale(p1, 3 * u * u * t)),
    add(scale(p2, 3 * u * t * t), scale(p3, t * t * t))
  );
};

const chordParameters = (
  points: readonly Point[],
  first: number,
  last: number
): number[] => {
  const lengths = [0];
  for (let index = first + 1; index <= last; index += 1) {
    lengths.push(
      (lengths.at(-1) ?? 0) + distance(at(points, index), at(points, index - 1))
    );
  }
  const total = lengths.at(-1) ?? 0;
  return lengths.map((length) => (total === 0 ? 0 : length / total));
};

/** The cubic through the end points, leaving along the tangents, closest to the run. */
const generate = (
  points: readonly Point[],
  first: number,
  last: number,
  parameters: readonly number[],
  startTangent: Point,
  endTangent: Point
): Cubic => {
  const p0 = at(points, first);
  const p3 = at(points, last);
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let index = first; index <= last; index += 1) {
    const t = parameters[index - first] ?? 0;
    const u = 1 - t;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const a0 = scale(startTangent, b1);
    const a1 = scale(endTangent, b2);
    const rest = subtract(
      at(points, index),
      add(scale(p0, u * u * u + b1), scale(p3, b2 + t * t * t))
    );
    c00 += dot(a0, a0);
    c01 += dot(a0, a1);
    c11 += dot(a1, a1);
    x0 += dot(a0, rest);
    x1 += dot(a1, rest);
  }
  const determinant = c00 * c11 - c01 * c01;
  const chord = distance(p0, p3);
  let alpha0 = determinant === 0 ? 0 : (x0 * c11 - x1 * c01) / determinant;
  let alpha1 = determinant === 0 ? 0 : (c00 * x1 - c01 * x0) / determinant;
  const floor = chord * 1e-6;
  if (alpha0 < floor || alpha1 < floor || alpha0 + alpha1 > 3 * chord) {
    alpha0 = chord / 3;
    alpha1 = chord / 3;
  }
  return [
    p0,
    add(p0, scale(startTangent, alpha0)),
    add(p3, scale(endTangent, alpha1)),
    p3,
  ];
};

interface Worst {
  readonly index: number;
  readonly squared: number;
}

const worstPoint = (
  points: readonly Point[],
  first: number,
  last: number,
  cubic: Cubic,
  parameters: readonly number[]
): Worst => {
  let squared = 0;
  let worst = Math.floor((first + last) / 2);
  for (let index = first + 1; index < last; index += 1) {
    const offset = subtract(
      cubicAt(cubic, parameters[index - first] ?? 0),
      at(points, index)
    );
    const here = dot(offset, offset);
    if (here >= squared) {
      squared = here;
      worst = index;
    }
  }
  return { index: worst, squared };
};

/** One Newton step moving a parameter towards the nearest place on the curve. */
const nearerParameter = (cubic: Cubic, point: Point, t: number): number => {
  const [p0, p1, p2, p3] = cubic;
  const d1: readonly Point[] = [
    scale(subtract(p1, p0), 3),
    scale(subtract(p2, p1), 3),
    scale(subtract(p3, p2), 3),
  ];
  const d2: readonly Point[] = [
    scale(subtract(at(d1, 1), at(d1, 0)), 2),
    scale(subtract(at(d1, 2), at(d1, 1)), 2),
  ];
  const u = 1 - t;
  const position = cubicAt(cubic, t);
  const first = add(
    add(scale(at(d1, 0), u * u), scale(at(d1, 1), 2 * u * t)),
    scale(at(d1, 2), t * t)
  );
  const second = add(scale(at(d2, 0), u), scale(at(d2, 1), t));
  const offset = subtract(position, point);
  const denominator = dot(first, first) + dot(offset, second);
  if (denominator === 0) {
    return t;
  }
  return Math.min(1, Math.max(0, t - dot(offset, first) / denominator));
};

const isStraight = (
  points: readonly Point[],
  first: number,
  last: number,
  tolerance: number
): boolean => {
  const from = at(points, first);
  const along = unit(subtract(at(points, last), from));
  for (let index = first + 1; index < last; index += 1) {
    const offset = subtract(at(points, index), from);
    if (Math.abs(offset.x * along.y - offset.y * along.x) > tolerance) {
      return false;
    }
  }
  return true;
};

const centreTangent = (
  points: readonly Point[],
  index: number,
  first: number,
  last: number
): Point => {
  const reach = Math.max(1, Math.min(2, index - first, last - index));
  return unit(subtract(at(points, index - reach), at(points, index + reach)));
};

interface Run {
  readonly points: readonly Point[];
  readonly tolerance: number;
}

const fitRange = (
  run: Run,
  first: number,
  last: number,
  startTangent: Point,
  endTangent: Point,
  into: Segment[]
) => {
  const { points, tolerance } = run;
  if (
    last - first < 2 ||
    isStraight(points, first, last, tolerance * LINE_SHARE)
  ) {
    into.push({ kind: "line", to: at(points, last) });
    return;
  }
  const limit = tolerance * tolerance;
  let parameters = chordParameters(points, first, last);
  let cubic = generate(
    points,
    first,
    last,
    parameters,
    startTangent,
    endTangent
  );
  let worst = worstPoint(points, first, last, cubic, parameters);
  for (
    let refit = 0;
    refit < REFITS && worst.squared > limit && worst.squared < limit * 16;
    refit += 1
  ) {
    const current = cubic;
    parameters = parameters.map((t, offset) =>
      nearerParameter(current, at(points, first + offset), t)
    );
    cubic = generate(points, first, last, parameters, startTangent, endTangent);
    worst = worstPoint(points, first, last, cubic, parameters);
  }
  if (worst.squared <= limit) {
    into.push({
      control1: cubic[1],
      control2: cubic[2],
      kind: "cubic",
      to: cubic[3],
    });
    return;
  }
  const tangent = centreTangent(points, worst.index, first, last);
  fitRange(run, first, worst.index, startTangent, tangent, into);
  fitRange(run, worst.index, last, scale(tangent, -1), endTangent, into);
};

/**
 * Lines and cubics from the first point of the run to the last. The tangents
 * are unit vectors pointing into the run from each end.
 */
export const fitRun = (
  points: readonly Point[],
  startTangent: Point,
  endTangent: Point,
  tolerance: number
): Segment[] => {
  const segments: Segment[] = [];
  fitRange(
    { points, tolerance },
    0,
    points.length - 1,
    startTangent,
    endTangent,
    segments
  );
  return segments;
};
