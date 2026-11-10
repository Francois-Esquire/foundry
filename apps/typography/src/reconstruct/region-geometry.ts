/**
 * The geometry of marking a region on a photograph: a dragged rectangle, or
 * four corners placed in any order. All in evidence pixels, y down.
 */
import type { Point } from "~/typeface/outline";
import {
  type Corners,
  type EvidenceRegion,
  quadrilateral,
  rectangle,
  regionCorners,
} from "./core";

export interface PictureSize {
  readonly height: number;
  readonly width: number;
}

/** A region smaller than this on either side holds no lettering worth reading. */
const SMALLEST_SIDE = 8;

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

export const clampPoint = ({ x, y }: Point, size: PictureSize): Point => ({
  x: Math.round(clamp(x, 0, size.width)),
  y: Math.round(clamp(y, 0, size.height)),
});

/**
 * The rectangle between two points of a drag, inside the picture. Undefined
 * when the drag was too small to be a region, as a stray click is.
 */
export const rectangleBetween = (
  from: Point,
  to: Point,
  size: PictureSize
): EvidenceRegion | undefined => {
  const a = clampPoint(from, size);
  const b = clampPoint(to, size);
  const width = Math.abs(b.x - a.x);
  const height = Math.abs(b.y - a.y);
  return width < SMALLEST_SIDE || height < SMALLEST_SIDE
    ? undefined
    : rectangle(Math.min(a.x, b.x), Math.min(a.y, b.y), width, height);
};

/**
 * Four points in the order a reader meets them: top left, top right, bottom
 * right, bottom left. The two highest are the top edge, so the corners can
 * be placed in any order.
 */
export const orderCorners = (
  points: readonly [Point, Point, Point, Point]
): Corners => {
  const byHeight = points.toSorted((a, b) => a.y - b.y);
  const across = (pair: readonly Point[]) => pair.toSorted((a, b) => a.x - b.x);
  const [topLeft, topRight] = across(byHeight.slice(0, 2));
  const [bottomLeft, bottomRight] = across(byHeight.slice(2));
  if (!(topLeft && topRight && bottomLeft && bottomRight)) {
    return points;
  }
  return [topLeft, topRight, bottomRight, bottomLeft];
};

/** Twice the signed area of a triangle: positive when it turns clockwise on screen. */
const turn = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** True when the corners enclose a real four-sided shape with no edge crossing another. */
export const isConvex = ([a, b, c, d]: Corners): boolean => {
  const turns = [turn(a, b, c), turn(b, c, d), turn(c, d, a), turn(d, a, b)];
  return turns.every((value) => value > 0);
};

/** The region four placed points make, or nothing when they do not enclose one. */
export const quadrilateralThrough = (
  points: readonly Point[],
  size: PictureSize
): EvidenceRegion | undefined => {
  const [a, b, c, d] = points.map((point) => clampPoint(point, size));
  if (!(a && b && c && d) || points.length !== 4) {
    return;
  }
  const corners = orderCorners([a, b, c, d]);
  return isConvex(corners) ? quadrilateral(corners) : undefined;
};

export const wholePicture = (size: PictureSize): EvidenceRegion =>
  rectangle(0, 0, size.width, size.height);

/** The same place marked the other way: a rectangle as its four corners, corners as their box. */
export const asCorners = (region: EvidenceRegion): EvidenceRegion =>
  quadrilateral(regionCorners(region));

export interface Box {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

/** The upright box around points, grown by a margin and kept inside the picture. */
export const boxAround = (
  points: readonly Point[],
  size: PictureSize,
  margin = 0
): Box => {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = clamp(Math.min(...xs) - margin, 0, size.width);
  const top = clamp(Math.min(...ys) - margin, 0, size.height);
  const right = clamp(Math.max(...xs) + margin, 0, size.width);
  const bottom = clamp(Math.max(...ys) + margin, 0, size.height);
  return { height: bottom - top, width: right - left, x: left, y: top };
};

export const asRectangle = (
  region: EvidenceRegion,
  size: PictureSize
): EvidenceRegion => {
  const box = boxAround(regionCorners(region), size);
  return rectangle(
    Math.round(box.x),
    Math.round(box.y),
    Math.round(box.width),
    Math.round(box.height)
  );
};

/** One number of a region, as the fields under the photograph name them. */
export type RegionField =
  | { readonly kind: "rectangle"; readonly part: keyof Box }
  | {
      readonly kind: "corner";
      readonly axis: "x" | "y";
      readonly corner: 0 | 1 | 2 | 3;
    };

/**
 * A region with one of its numbers replaced, as typed. Undefined when the
 * result is not a region: too small, outside the picture, or with corners
 * that cross.
 */
export const withRegionNumber = (
  region: EvidenceRegion,
  field: RegionField,
  value: number,
  size: PictureSize
): EvidenceRegion | undefined => {
  if (!Number.isFinite(value)) {
    return;
  }
  if (field.kind === "rectangle" && region.kind === "rectangle") {
    const next = { ...region, [field.part]: Math.round(value) };
    return rectangleBetween(
      { x: next.x, y: next.y },
      { x: next.x + next.width, y: next.y + next.height },
      size
    );
  }
  if (field.kind === "corner" && region.kind === "quadrilateral") {
    const moved = region.corners.map((corner, index) =>
      index === field.corner
        ? clampPoint({ ...corner, [field.axis]: value }, size)
        : corner
    );
    const [a, b, c, d] = moved;
    if (!(a && b && c && d)) {
      return;
    }
    const corners: Corners = [a, b, c, d];
    return isConvex(corners) ? quadrilateral(corners) : undefined;
  }
};
