/** Sets one line of text from a face's own outlines, as a single outline in font units. */
import {
  type Contour,
  type Outline,
  translateOutline,
} from "~/typeface/outline";
import type { OpenFace, ShapeOptions } from "~/typeface/reading";

const FALLBACK_GLYPH = 0;

/**
 * Shapes the text and lays its glyphs along the baseline from the origin. A
 * character the face lacks leaves its space empty: the fallback box is not
 * part of the design, so it is not drawn.
 */
export const lineOutline = (
  face: OpenFace,
  text: string,
  options: ShapeOptions = {}
): Outline => {
  const contours: Contour[] = [];
  let pen = 0;
  for (const shaped of face.shape(text, options).glyphs) {
    if (shaped.glyphId !== FALLBACK_GLYPH) {
      const { outline } = face.glyph(shaped.glyphId, options.location);
      contours.push(
        ...translateOutline(outline, pen + shaped.xOffset, shaped.yOffset)
          .contours
      );
    }
    pen += shaped.xAdvance;
  }
  return { contours };
};
