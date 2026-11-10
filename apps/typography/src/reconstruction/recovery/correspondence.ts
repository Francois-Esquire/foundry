/**
 * Correspondence: where a recovered outline lies on the evidence it came
 * from, so a screen can lay the outline over the photograph, and how well
 * the outline fits the shape it was traced from.
 */
import type { Bitmap } from "~/generation/raster/bitmap";
import { intersectionOverUnion } from "~/generation/raster/bitmap";
import {
  frameTransform,
  type RasterFrame,
  rasterizeOutline,
} from "~/generation/raster/rasterize";
import {
  mapOutline,
  type Outline,
  type Point,
  type Transform,
} from "~/typeface/outline";
import type { RegionView } from "../evidence/rectify";

export interface Correspondence {
  /** Where a point of the outline, in font units, lies on the evidence, in evidence pixels. */
  place(point: Point): Point;
  /**
   * Font units to evidence pixels as one transform. Only a rectangular
   * region has one. A four-corner region maps back by a projective map, and
   * `place` applies it point by point.
   */
  readonly toEvidence?: Transform;
  /** Font units to pixels of the region's upright view, with y down. */
  readonly toView: Transform;
}

/** The transform that applies `first` and then `second`. */
const compose = (first: Transform, second: Transform): Transform => ({
  dx: second.xx * first.dx + second.yx * first.dy + second.dx,
  dy: second.xy * first.dx + second.yy * first.dy + second.dy,
  xx: second.xx * first.xx + second.yx * first.xy,
  xy: second.xy * first.xx + second.yy * first.xy,
  yx: second.xx * first.yx + second.yx * first.yy,
  yy: second.xy * first.yx + second.yy * first.yy,
});

const apply = (t: Transform, { x, y }: Point): Point => ({
  x: t.xx * x + t.yx * y + t.dx,
  y: t.xy * x + t.yy * y + t.dy,
});

/**
 * The correspondence of an outline whose frame places a cut-out of the view
 * in font units. `origin` is the cut-out's top left corner in the view.
 */
export const correspondenceOf = (
  frame: RasterFrame,
  origin: Point,
  view: RegionView
): Correspondence => {
  const toView = compose(frameTransform(frame), {
    dx: origin.x,
    dy: origin.y,
    xx: 1,
    xy: 0,
    yx: 0,
    yy: 1,
  });
  return {
    place: (point) => view.toEvidence(apply(toView, point)),
    toEvidence: view.viewToEvidence && compose(toView, view.viewToEvidence),
    toView,
  };
};

/**
 * The outline as it lies on the evidence, in evidence pixels with y down.
 * Under a four-corner region the curve points are carried over one by one,
 * which is exact for corners and line ends and very close for curves.
 */
export const outlineOnEvidence = (
  outline: Outline,
  correspondence: Correspondence
): Outline => mapOutline(outline, correspondence.place);

/**
 * The fit score: intersection over union between the outline, drawn back
 * into the frame it was traced in, and the isolated shape it came from.
 */
export const fitScore = (
  outline: Outline,
  frame: RasterFrame,
  isolated: Bitmap
): number => intersectionOverUnion(isolated, rasterizeOutline(outline, frame));
