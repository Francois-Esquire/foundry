/**
 * Shape agreement between two outlines: intersection over union of their
 * rasterised ink. Used for holdout tests, where the face's own glyph is the
 * answer a generated one is compared with.
 */
import {
  type Bounds,
  type Outline,
  outlineBounds,
  translateOutline,
} from "~/typeface/outline";
import { type Bitmap, intersectionOverUnion } from "../raster/bitmap";
import { frameAround, rasterizeOutline } from "../raster/rasterize";

export interface Agreement {
  /** After sliding one shape over the other to where they agree best. */
  readonly aligned: number;
  /** With both shapes left where they are. */
  readonly inPlace: number;
}

/** Pixels per em when comparing shapes. */
const COMPARE_EM = 256;
/** How far, in pixels, the best alignment is searched around matching centres. */
const SEARCH = 3;

const union = (a: Bounds, b: Bounds): Bounds => ({
  xMax: Math.max(a.xMax, b.xMax),
  xMin: Math.min(a.xMin, b.xMin),
  yMax: Math.max(a.yMax, b.yMax),
  yMin: Math.min(a.yMin, b.yMin),
});

const centre = (bounds: Bounds) => ({
  x: (bounds.xMin + bounds.xMax) / 2,
  y: (bounds.yMin + bounds.yMax) / 2,
});

const bestAround = (reference: Bitmap, candidate: Bitmap): number => {
  let best = 0;
  for (let dy = -SEARCH; dy <= SEARCH; dy += 1) {
    for (let dx = -SEARCH; dx <= SEARCH; dx += 1) {
      best = Math.max(
        best,
        intersectionOverUnion(reference, candidate, { x: dx, y: dy })
      );
    }
  }
  return best;
};

/** How well a candidate outline agrees with a reference, in the same units. */
export const shapeAgreement = (
  candidate: Outline,
  reference: Outline,
  unitsPerEm: number
): Agreement => {
  const candidateBounds = outlineBounds(candidate);
  const referenceBounds = outlineBounds(reference);
  if (!(candidateBounds && referenceBounds)) {
    const same = candidateBounds === referenceBounds ? 1 : 0;
    return { aligned: same, inPlace: same };
  }
  const scale = COMPARE_EM / unitsPerEm;
  const frame = frameAround(union(candidateBounds, referenceBounds), scale);
  const drawnReference = rasterizeOutline(reference, frame);
  const from = centre(candidateBounds);
  const to = centre(referenceBounds);
  // Centres are matched in outline units, finer than a pixel, before the
  // search tries whole-pixel shifts around that.
  const centred = translateOutline(candidate, to.x - from.x, to.y - from.y);
  return {
    aligned: bestAround(drawnReference, rasterizeOutline(centred, frame)),
    inPlace: intersectionOverUnion(
      drawnReference,
      rasterizeOutline(candidate, frame)
    ),
  };
};
