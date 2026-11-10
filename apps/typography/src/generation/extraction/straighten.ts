/**
 * Straightens a sheet whose ink is slightly turned, and finds the baseline
 * and body height of each row from where the glyphs' ink stops.
 */
import type { Transform } from "~/typeface/outline";
import { median } from "../style/measure";

export interface InkFoot {
  /** The lowest ink of a glyph, in sheet pixels from the top. */
  readonly bottom: number;
  readonly row: number;
  /** The highest ink of the glyph. */
  readonly top: number;
  /** The horizontal middle of the glyph's ink. */
  readonly x: number;
}

/** Turns smaller than this many degrees are pixel noise, not rotation. */
const NOTICEABLE = 0.2;
const MAXIMUM = 10;

/**
 * How far the sheet is turned, in degrees clockwise as seen: the middle
 * slope between the feet of glyphs that share a row. Most glyphs stand on
 * the baseline, so the few that descend do not move the middle.
 */
export const rotationOf = (
  feet: readonly InkFoot[],
  minimumGap: number
): number => {
  const slopes: number[] = [];
  for (const a of feet) {
    for (const b of feet) {
      if (a.row === b.row && b.x - a.x >= minimumGap) {
        slopes.push((b.bottom - a.bottom) / (b.x - a.x));
      }
    }
  }
  const slope = slopes.length >= 3 ? (median(slopes) ?? 0) : 0;
  const degrees = (Math.atan(slope) * 180) / Math.PI;
  return Math.abs(degrees) >= NOTICEABLE && Math.abs(degrees) <= MAXIMUM
    ? degrees
    : 0;
};

/** The transform that undoes a turn about a centre, in coordinates with y down. */
export const straightening = (
  degrees: number,
  centre: { readonly x: number; readonly y: number }
): Transform => {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    dx: centre.x - cos * centre.x - sin * centre.y,
    dy: centre.y + sin * centre.x - cos * centre.y,
    xx: cos,
    xy: -sin,
    yx: sin,
    yy: cos,
  };
};

/**
 * The value most of the given ones agree on, to within the tolerance: the
 * middle of the largest group. Ties go to the first group in the order given.
 */
export const dominant = (
  values: readonly number[],
  tolerance: number
): number | undefined => {
  let best: number[] = [];
  for (const value of values) {
    const group = values.filter(
      (other) => Math.abs(other - value) <= tolerance
    );
    if (group.length > best.length) {
      best = group;
    }
  }
  return median(best);
};
