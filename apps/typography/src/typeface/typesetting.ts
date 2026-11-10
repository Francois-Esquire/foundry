/**
 * Sets text in a face as the project currently has it. Shaping comes from the
 * source font; edited advances and added glyphs are laid over the result, so
 * an edit shows in text at once, without building a font.
 *
 * Layout rules added as feature code are not applied here. Text that depends
 * on them is proved with a built font.
 */
import {
  addedGlyph,
  type GlyphRef,
  resolveGlyph,
  sourceGlyph,
  type WorkingFace,
} from "./changes";
import type { Outline } from "./outline";
import type { OpenFace, ShapeOptions, TextDirection } from "./reading";

export interface PlacedGlyph {
  readonly advance: number;
  /** Index of the first UTF-16 code unit this glyph came from. */
  readonly cluster: number;
  /** True when no glyph exists for the character, in the source or the project. */
  readonly missing: boolean;
  readonly outline: Outline;
  readonly ref: GlyphRef;
  /** Where the glyph's origin sits on the line, in font units. */
  readonly x: number;
  readonly y: number;
}

export interface SetLine {
  readonly direction: TextDirection;
  readonly glyphs: readonly PlacedGlyph[];
  readonly width: number;
}

const NOTDEF = 0;

export const setText = (
  text: string,
  face: OpenFace,
  working: WorkingFace,
  options: ShapeOptions = {}
): SetLine => {
  const readSource = (glyphId: number) => face.glyph(glyphId, options.location);
  const run = face.shape(text, options);
  const glyphs: PlacedGlyph[] = [];
  let pen = 0;
  for (const shaped of run.glyphs) {
    const character = text.codePointAt(shaped.cluster);
    const addedKey =
      shaped.glyphId === NOTDEF && character !== undefined
        ? working.characters.get(character)
        : undefined;
    const ref =
      addedKey === undefined
        ? sourceGlyph(shaped.glyphId)
        : addedGlyph(addedKey);
    const glyph = resolveGlyph(working, ref, readSource);
    if (!glyph) {
      continue;
    }
    // Kerning lives in the difference between the shaped and the plain
    // advance, so an edited advance keeps the pair adjustment on top of it.
    const adjustment =
      ref.kind === "source"
        ? shaped.xAdvance - readSource(shaped.glyphId).advance
        : 0;
    const advance = glyph.advance + adjustment;
    glyphs.push({
      advance,
      cluster: shaped.cluster,
      missing: shaped.glyphId === NOTDEF && addedKey === undefined,
      outline: glyph.outline,
      ref,
      x: pen + (ref.kind === "source" ? shaped.xOffset : 0),
      y: ref.kind === "source" ? shaped.yOffset : 0,
    });
    pen += advance;
  }
  return { direction: run.direction, glyphs, width: pen };
};
