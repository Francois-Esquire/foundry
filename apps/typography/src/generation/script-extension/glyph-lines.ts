/**
 * Reads a finished glyph against the model's lines: where its headline runs,
 * where its main stem stands and where the ink under the headline begins.
 * Spacing and anchors are computed from these, so they come from each
 * glyph's own geometry.
 */
import {
  type Outline,
  outlineBounds,
  transformOutline,
} from "~/typeface/outline";
import { frameAround, rasterizeOutline } from "../raster/rasterize";
import {
  findHeadline,
  findMainStem,
  headlineBetween,
  partsUnderHeadline,
} from "./headline";
import type { HeadlineLines } from "./headline-lines";

export interface GlyphOnLines {
  /** The leftmost ink under the headline. */
  readonly bodyLeft?: number;
  /** The ends of the glyph's own stretch of headline. */
  readonly headline: { readonly left: number; readonly right: number };
  /** The middle of the main stem. */
  readonly stem?: number;
}

/** Pixels from the baseline to the top of the headline when a glyph is measured. */
const PIXELS_PER_HEADLINE = 400;
/** The share of the headline's thickness, under it, where strokes are still rounding into it. */
const JOIN_ROUNDING = 0.25;

const pictureOf = (outline: Outline, lines: HeadlineLines) => {
  const bounds = outlineBounds(outline);
  if (!bounds) {
    return;
  }
  const frame = frameAround(bounds, PIXELS_PER_HEADLINE / lines.headlineTop);
  return {
    bitmap: rasterizeOutline(outline, frame),
    frame,
    thickness: lines.headlineThickness * frame.scale,
  };
};

/**
 * Scales a glyph about the baseline until its own headline sits on the
 * model's. Glyphs from one sheet differ by a few units, and a step between
 * two headlines shows in every word.
 */
export const snapToHeadline = (
  outline: Outline,
  lines: HeadlineLines
): Outline => {
  const picture = pictureOf(outline, lines);
  const band = picture && findHeadline(picture.bitmap, picture.thickness);
  const top = band && picture.frame.top - band.top / picture.frame.scale;
  if (!(top && top > 0)) {
    return outline;
  }
  const fit = lines.headlineTop / top;
  return transformOutline(outline, {
    dx: 0,
    dy: 0,
    xx: fit,
    xy: 0,
    yx: 0,
    yy: fit,
  });
};

/** How thick a glyph's own headline is, in font units. Nothing when it has none. */
export const headlineThicknessOf = (
  outline: Outline,
  lines: HeadlineLines
): number | undefined => {
  const picture = pictureOf(outline, lines);
  const band = picture && findHeadline(picture.bitmap, picture.thickness);
  return band && (band.bottom - band.top) / picture.frame.scale;
};

/** Reads a glyph that already stands on the model's lines. Nothing for one with no ink in the headline. */
export const readOnLines = (
  outline: Outline,
  lines: HeadlineLines
): GlyphOnLines | undefined => {
  const picture = pictureOf(outline, lines);
  if (!picture) {
    return;
  }
  const { bitmap, frame } = picture;
  const rowAt = (y: number) => Math.round((frame.top - y) * frame.scale);
  const xAt = (column: number) => frame.left + column / frame.scale;
  const band = headlineBetween(
    bitmap,
    rowAt(lines.headlineTop),
    rowAt(lines.bodyTop)
  );
  if (!band) {
    return;
  }
  const stem = findMainStem(bitmap, band);
  const [body] = partsUnderHeadline(
    bitmap,
    band,
    Math.round(JOIN_ROUNDING * (band.bottom - band.top))
  );
  return {
    bodyLeft: body && xAt(body.start),
    headline: { left: xAt(band.left), right: xAt(band.right) },
    stem: stem && xAt((stem.start + stem.end) / 2),
  };
};
