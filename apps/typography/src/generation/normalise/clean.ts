/** Outline cleaning: no specks, no doubled points, whole-number coordinates. */
import type { Contour, Outline, Point, Segment } from "~/typeface/outline";
import { flattenContour, signedArea } from "../raster/flatten";

export interface CleanOptions {
  /** Points closer than this are one point. */
  readonly mergeDistance?: number;
  /** Contours enclosing less than this many square units are dropped. */
  readonly minimumArea: number;
}

export interface CleanResult {
  readonly mergedPoints: number;
  readonly outline: Outline;
  readonly removedContours: number;
}

const DEFAULT_MERGE_DISTANCE = 1;

const round = ({ x, y }: Point): Point => ({
  x: Math.round(x),
  y: Math.round(y),
});

const roundSegment = (segment: Segment): Segment => {
  if (segment.kind === "line") {
    return { kind: "line", to: round(segment.to) };
  }
  if (segment.kind === "quadratic") {
    return {
      control: round(segment.control),
      kind: "quadratic",
      to: round(segment.to),
    };
  }
  return {
    control1: round(segment.control1),
    control2: round(segment.control2),
    kind: "cubic",
    to: round(segment.to),
  };
};

const apart = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Whether a segment goes nowhere: its end, and any control points, sit on its start. */
const isStub = (from: Point, segment: Segment, distance: number): boolean => {
  if (apart(from, segment.to) >= distance) {
    return false;
  }
  if (segment.kind === "line") {
    return true;
  }
  const controls =
    segment.kind === "quadratic"
      ? [segment.control]
      : [segment.control1, segment.control2];
  return controls.every((control) => apart(from, control) < distance);
};

const mergePoints = (
  contour: Contour,
  distance: number
): { readonly contour: Contour; readonly merged: number } => {
  const start = round(contour.start);
  const segments: Segment[] = [];
  let from = start;
  let merged = 0;
  for (const segment of contour.segments.map(roundSegment)) {
    if (isStub(from, segment, distance)) {
      merged += 1;
      continue;
    }
    segments.push(segment);
    from = segment.to;
  }
  return { contour: { segments, start }, merged };
};

/** Rounds to whole units, merges near-duplicate points and drops contours too small to be drawn on purpose. */
export const cleanOutline = (
  outline: Outline,
  options: CleanOptions
): CleanResult => {
  const distance = options.mergeDistance ?? DEFAULT_MERGE_DISTANCE;
  const contours: Contour[] = [];
  let mergedPoints = 0;
  let removedContours = 0;
  for (const original of outline.contours) {
    const { contour, merged } = mergePoints(original, distance);
    const area = Math.abs(signedArea(flattenContour(contour, 1)));
    if (contour.segments.length < 2 || area < options.minimumArea) {
      removedContours += 1;
      continue;
    }
    mergedPoints += merged;
    contours.push(contour);
  }
  return { mergedPoints, outline: { contours }, removedContours };
};

/** The smallest area a contour may enclose before it counts as debris: a fifth of a stem squared. */
export const debrisArea = (stem: number, unitsPerEm: number) =>
  Math.max((stem / 5) ** 2, (unitsPerEm / 200) ** 2);
