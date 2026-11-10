/**
 * The view of the glyph drawing: how font units become screen pixels. Font
 * units have y pointing up, the screen has y pointing down.
 */
import type { Bounds, Point } from "~/typeface/outline";

export interface ViewTransform {
  /** Where the glyph origin sits on screen, in pixels. */
  readonly originX: number;
  readonly originY: number;
  /** Screen pixels per font unit. */
  readonly scale: number;
}

export interface FrameSize {
  readonly height: number;
  readonly width: number;
}

const MIN_SCALE = 0.01;
const MAX_SCALE = 40;

export const toScreen = (view: ViewTransform, point: Point): Point => ({
  x: view.originX + point.x * view.scale,
  y: view.originY - point.y * view.scale,
});

export const toFont = (view: ViewTransform, point: Point): Point => ({
  x: (point.x - view.originX) / view.scale,
  y: (view.originY - point.y) / view.scale,
});

/** The view that centres a box of font units in the frame, leaving a margin in pixels. */
export const fitView = (
  frame: FrameSize,
  box: Bounds,
  margin = 0
): ViewTransform => {
  const boxWidth = Math.max(1, box.xMax - box.xMin);
  const boxHeight = Math.max(1, box.yMax - box.yMin);
  const room = {
    height: Math.max(1, frame.height - 2 * margin),
    width: Math.max(1, frame.width - 2 * margin),
  };
  const scale = Math.min(
    MAX_SCALE,
    Math.max(
      MIN_SCALE,
      Math.min(room.width / boxWidth, room.height / boxHeight)
    )
  );
  return {
    originX: frame.width / 2 - ((box.xMin + box.xMax) / 2) * scale,
    originY: frame.height / 2 + ((box.yMin + box.yMax) / 2) * scale,
    scale,
  };
};

/** Zooms by a factor while the font point under the anchor stays where it is on screen. */
export const zoomAt = (
  view: ViewTransform,
  anchor: Point,
  factor: number
): ViewTransform => {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const held = toFont(view, anchor);
  return {
    originX: anchor.x - held.x * scale,
    originY: anchor.y + held.y * scale,
    scale,
  };
};

/** Moves the drawing by a distance in screen pixels. */
export const panBy = (
  view: ViewTransform,
  dx: number,
  dy: number
): ViewTransform => ({
  ...view,
  originX: view.originX + dx,
  originY: view.originY + dy,
});

/** The SVG transform that draws font units through this view. */
export const svgTransform = (view: ViewTransform) =>
  `translate(${view.originX} ${view.originY}) scale(${view.scale} ${-view.scale})`;
