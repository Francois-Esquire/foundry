/**
 * The built-in tracer: follow the ink edge, cut it at corners and extremes,
 * and fit each piece with as few lines and cubics as the tolerance allows.
 */
import type { Contour, Outline, Point, Segment } from "~/typeface/outline";
import { signedArea } from "~/typeface/outline-geometry";
import { INK_THRESHOLD } from "../raster/bitmap";
import {
  type Knot,
  type KnottedLoop,
  knotLoop,
  resampleLoop,
} from "./breakpoints";
import { followContours } from "./contours";
import { fitRun, unit } from "./fit-curve";
import type { TraceOptions, Vectorizer } from "./vectorizer";

const DEFAULT_TOLERANCE = 0.75;
const DEFAULT_CORNER_ANGLE = 40;
const DEFAULT_MINIMUM_AREA = 6;
/** How many samples from a corner its tangent is read. */
const CORNER_REACH = 3;

const pointAt = (points: readonly Point[], index: number): Point =>
  points[Math.min(points.length - 1, Math.max(0, index))] ?? { x: 0, y: 0 };

/** The unit direction of travel leaving a knot (`forward`) or arriving at it. */
const tangentAt = (
  { points }: KnottedLoop,
  knot: Knot,
  other: Knot,
  forward: boolean
): Point => {
  const sign = forward ? 1 : -1;
  const reach = Math.max(
    1,
    Math.min(CORNER_REACH, Math.abs(other.index - knot.index) - 1)
  );
  const here = pointAt(points, knot.index);
  const near = pointAt(points, knot.index + sign * reach);
  const travel = { x: near.x - here.x, y: near.y - here.y };
  if (knot.kind === "extreme-y") {
    return { x: Math.sign(travel.x) || sign, y: 0 };
  }
  if (knot.kind === "extreme-x") {
    return { x: 0, y: Math.sign(travel.y) || sign };
  }
  return unit(travel);
};

const isCollinear = (from: Point, middle: Point, to: Point, slack: number) => {
  const along = unit({ x: to.x - from.x, y: to.y - from.y });
  const offset = { x: middle.x - from.x, y: middle.y - from.y };
  return Math.abs(offset.x * along.y - offset.y * along.x) <= slack;
};

/** Joins neighbouring lines that run the same way, which a split can leave behind. */
const mergeLines = (
  start: Point,
  segments: readonly Segment[],
  slack: number
): Segment[] => {
  const merged: Segment[] = [];
  let anchor = start;
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (
      segment.kind === "line" &&
      previous?.kind === "line" &&
      isCollinear(anchor, previous.to, segment.to, slack)
    ) {
      merged[merged.length - 1] = segment;
      continue;
    }
    if (previous) {
      anchor = previous.to;
    }
    merged.push(segment);
  }
  return merged;
};

const fitLoop = (
  loop: readonly Point[],
  tolerance: number,
  cornerAngle: number
): Contour | undefined => {
  const knotted = knotLoop(resampleLoop(loop), cornerAngle);
  const [start] = knotted.points;
  if (!start) {
    return;
  }
  const segments: Segment[] = [];
  for (let position = 0; position < knotted.knots.length - 1; position += 1) {
    const from = knotted.knots[position];
    const to = knotted.knots[position + 1];
    if (!(from && to) || to.index <= from.index) {
      continue;
    }
    segments.push(
      ...fitRun(
        knotted.points.slice(from.index, to.index + 1),
        tangentAt(knotted, from, to, true),
        tangentAt(knotted, to, from, false),
        tolerance
      )
    );
  }
  return { segments: mergeLines(start, segments, tolerance / 2), start };
};

export const contourTracer: Vectorizer = {
  id: "contour-fit",
  trace(bitmap, options: TraceOptions = {}): Outline {
    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
    const minimumArea = options.minimumArea ?? DEFAULT_MINIMUM_AREA;
    const contours = followContours(bitmap, options.threshold ?? INK_THRESHOLD)
      .filter((loop) => Math.abs(signedArea(loop)) >= minimumArea)
      .map((loop) =>
        fitLoop(loop, tolerance, options.cornerAngle ?? DEFAULT_CORNER_ANGLE)
      )
      .filter((contour) => contour !== undefined);
    return { contours };
  },
};
