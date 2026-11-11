import { type Bitmap, intersectionOverUnion } from "~/generation/raster/bitmap";
import {
  frameAround,
  type RasterFrame,
  rasterizeOutline,
} from "~/generation/raster/rasterize";
import { type Outline, outlineBounds } from "~/typeface/outline";
import type { GlyphShape, OpenFace } from "~/typeface/reading";

export const glyphOf = (face: OpenFace, character: string): GlyphShape => {
  const glyphId = face.glyphForCharacter(character.codePointAt(0) ?? 0);
  if (glyphId === undefined) {
    throw new Error(`The fixture face has no glyph for ${character}.`);
  }
  return face.glyph(glyphId);
};

/** The single glyph a text shapes to, for forms no character maps to. */
export const shapedGlyphOf = (face: OpenFace, text: string): GlyphShape => {
  const { glyphs } = face.shape(text);
  const [only] = glyphs;
  if (glyphs.length !== 1 || !only) {
    throw new Error(`${text} did not shape to one glyph.`);
  }
  return face.glyph(only.glyphId);
};

export const frameOf = (outline: Outline, scale: number): RasterFrame => {
  const bounds = outlineBounds(outline);
  if (!bounds) {
    throw new Error("An empty outline has no frame.");
  }
  return frameAround(bounds, scale);
};

/** Intersection over union of two outlines drawn in the same frame, unaligned. */
export const outlineAgreement = (
  a: Outline,
  b: Outline,
  frame: RasterFrame
): number => {
  const draw = (outline: Outline): Bitmap => rasterizeOutline(outline, frame);
  return intersectionOverUnion(draw(a), draw(b));
};
