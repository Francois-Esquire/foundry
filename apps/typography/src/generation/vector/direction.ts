/**
 * Contour direction. A filled shape and the counters inside it must run
 * opposite ways for the non-zero rule to leave the counters open.
 */
import type { Contour, Outline, Point, Segment } from "~/typeface/outline";
import { flattenContour, polygonContains, signedArea } from "../raster/flatten";

const FLATNESS = 2;
/** How finely an edge is sampled, as a share of the contour's size. */
const EDGE_SAMPLES = 24;

export const reverseContour = (contour: Contour): Contour => {
  const ends = [
    contour.start,
    ...contour.segments.map((segment) => segment.to),
  ];
  const segments: Segment[] = [];
  for (let index = contour.segments.length - 1; index >= 0; index -= 1) {
    const segment = contour.segments[index];
    const to = ends[index];
    if (!(segment && to)) {
      continue;
    }
    if (segment.kind === "line") {
      segments.push({ kind: "line", to });
    } else if (segment.kind === "quadratic") {
      segments.push({ control: segment.control, kind: "quadratic", to });
    } else {
      segments.push({
        control1: segment.control2,
        control2: segment.control1,
        kind: "cubic",
        to,
      });
    }
  }
  return { segments, start: ends.at(-1) ?? contour.start };
};

export interface Nesting {
  /** Signed area of the contour: positive when it runs counter-clockwise with y up. */
  readonly area: number;
  /** How many other contours of the outline wholly enclose this one. */
  readonly depth: number;
}

interface Extent {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

const extentOf = (polygon: readonly Point[]): Extent => {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  return {
    bottom: Math.min(...ys),
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.max(...ys),
  };
};

/** Points along a polygon's edges, close enough together that an edge cannot slip out between two of them. */
const alongEdges = (polygon: readonly Point[], extent: Extent): Point[] => {
  const step =
    Math.max(extent.right - extent.left, extent.top - extent.bottom, 1) /
    EDGE_SAMPLES;
  const points: Point[] = [];
  let from = polygon.at(-1);
  for (const to of polygon) {
    if (from) {
      const pieces = Math.max(
        1,
        Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step)
      );
      for (let piece = 1; piece <= pieces; piece += 1) {
        const t = piece / pieces;
        points.push({
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
        });
      }
    }
    from = to;
  }
  return points;
};

const fitsInside = (inner: Extent, outer: Extent) =>
  inner.left >= outer.left &&
  inner.right <= outer.right &&
  inner.bottom >= outer.bottom &&
  inner.top <= outer.top;

/**
 * Each contour's area and how deeply it sits inside the others. A contour is
 * inside another only when every point of it is: one that crosses another's
 * edge overlaps it, as the strokes of an unmerged design do, and is no counter.
 */
export const nestingOf = (outline: Outline): Nesting[] => {
  const polygons = outline.contours.map((contour) =>
    flattenContour(contour, FLATNESS)
  );
  const extents = polygons.map(extentOf);
  return polygons.map((polygon, index) => {
    const extent = extents[index];
    const depth = polygons.filter((other, otherIndex) => {
      const around = extents[otherIndex];
      return (
        otherIndex !== index &&
        extent !== undefined &&
        around !== undefined &&
        fitsInside(extent, around) &&
        alongEdges(polygon, extent).every((point) =>
          polygonContains(other, point)
        )
      );
    }).length;
    return { area: signedArea(polygon), depth };
  });
};

/**
 * Where a contour lies against a filled shape made of several contours:
 * wholly in its ink, wholly off it (on paper, or in a counter it already
 * has), or across its edge.
 */
export const standingOf = (
  contour: Contour,
  shape: readonly Contour[]
): "across" | "in-ink" | "off-ink" => {
  const polygon = flattenContour(contour, FLATNESS);
  const polygons = shape.map((part) => flattenContour(part, FLATNESS));
  const inInk = alongEdges(polygon, extentOf(polygon)).map(
    (point) =>
      polygons.filter((part) => polygonContains(part, point)).length % 2 === 1
  );
  if (inInk.every(Boolean)) {
    return "in-ink";
  }
  return inInk.some(Boolean) ? "across" : "off-ink";
};

/** Whether a contour runs the way its depth calls for: shapes one way, counters the other. */
export const runsCorrectly = ({ area, depth }: Nesting) =>
  depth % 2 === 0 ? area >= 0 : area <= 0;

/**
 * Turns contours so that shapes run counter-clockwise and the counters inside
 * them clockwise, whatever direction they were drawn in.
 */
export const orientByNesting = (outline: Outline): Outline => {
  const nesting = nestingOf(outline);
  return {
    contours: outline.contours.map((contour, index) => {
      const own = nesting[index];
      return own && !runsCorrectly(own) ? reverseContour(contour) : contour;
    }),
  };
};
