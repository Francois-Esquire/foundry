/** What lies under the pointer on the glyph drawing. */

import type { FaceMetrics } from "~/typeface/face";
import type { Bounds, Point } from "~/typeface/outline";
import { outlineBounds } from "~/typeface/outline";
import {
  nearestPoint,
  nearestSegment,
  type PointAddress,
} from "~/typeface/outline-editing";
import type { GlyphShape } from "~/typeface/reading";
import type { NodePlace } from "./glyph-editor";
import { toFont, toScreen, type ViewTransform } from "./view-transform";

export type CanvasHit =
  | { readonly kind: "point"; readonly address: PointAddress }
  | { readonly kind: "line"; readonly measure: "advance" | "left" }
  | { readonly kind: "nothing" };

/** How near the pointer must come, in screen pixels. */
const POINT_REACH = 8;
const LINE_REACH = 5;
const OUTLINE_REACH = 7;

/**
 * A point wins over a line. The origin line sets the left bearing, so it
 * only answers when the glyph has something drawn.
 */
export const hitAt = (
  view: ViewTransform,
  shape: GlyphShape,
  position: Point
): CanvasHit => {
  const point = nearestPoint(
    shape.outline,
    toFont(view, position),
    POINT_REACH / view.scale
  );
  if (point) {
    return { address: point.address, kind: "point" };
  }
  const advanceX = toScreen(view, { x: shape.advance, y: 0 }).x;
  if (Math.abs(position.x - advanceX) <= LINE_REACH) {
    return { kind: "line", measure: "advance" };
  }
  const originX = toScreen(view, { x: 0, y: 0 }).x;
  if (
    shape.outline.contours.length > 0 &&
    Math.abs(position.x - originX) <= LINE_REACH
  ) {
    return { kind: "line", measure: "left" };
  }
  return { kind: "nothing" };
};

/** The place on the outline under the pointer, for adding a node there. */
export const outlinePlaceAt = (
  view: ViewTransform,
  shape: GlyphShape,
  position: Point
): NodePlace | undefined => {
  const hit = nearestSegment(shape.outline, toFont(view, position));
  return hit && hit.distance * view.scale <= OUTLINE_REACH
    ? { contour: hit.contour, segment: hit.segment, t: hit.t }
    : undefined;
};

/** The font units a drawing should show: the glyph, its advance and the face's vertical metrics. */
export const drawingBox = (metrics: FaceMetrics, shape: GlyphShape): Bounds => {
  const bounds = outlineBounds(shape.outline);
  return {
    xMax: Math.max(shape.advance, bounds?.xMax ?? 0),
    xMin: Math.min(0, bounds?.xMin ?? 0),
    yMax: Math.max(metrics.ascender, bounds?.yMax ?? 0),
    yMin: Math.min(metrics.descender, bounds?.yMin ?? 0),
  };
};
