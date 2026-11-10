/**
 * The observed letters as a face. Generation measures style, draws reference
 * sheets and briefs its strategies from an `OpenFace`, so the recovered
 * outlines are given that shape and every one of those tools works on them
 * unchanged. It is a view over outlines, not a font: there is no file behind
 * it, no layout, and one glyph for each character.
 */
import { glyphNameFor } from "~/generation/plan/target";
import type { FaceDescription } from "~/typeface/face";
import { EMPTY_OUTLINE, type Outline } from "~/typeface/outline";
import type { GlyphShape, OpenFace, ShapedGlyph } from "~/typeface/reading";
import type { RecoveryMetrics } from "../recovery/recover";

export interface ObservedGlyph {
  readonly advance: number;
  readonly character: number;
  readonly outline: Outline;
}

const describe = (
  familyName: string,
  glyphs: number,
  metrics: RecoveryMetrics
): FaceDescription => ({
  axes: [],
  characterCount: glyphs,
  familyName,
  fullName: `${familyName} Observed`,
  glyphCount: glyphs + 1,
  instances: [],
  italic: false,
  layout: { positioning: [], scripts: [], substitution: [] },
  licence: { embedding: 0 },
  // The cap height and x-height are left undeclared on purpose, so a style
  // analysis reports them as measured from the letters or as assumed.
  metrics: {
    ascender: metrics.ascender,
    descender: metrics.descender,
    lineGap: 0,
    unitsPerEm: metrics.unitsPerEm,
  },
  outlineFormat: "none",
  postScriptName: `${familyName.replaceAll(/\s+/g, "")}-Observed`,
  styleName: "Observed",
  weightClass: 400,
  widthClass: 5,
});

/** A face made of observed glyphs. Glyph 0 is empty and stands for every other character. */
export const observedFace = (
  glyphs: readonly ObservedGlyph[],
  metrics: RecoveryMetrics,
  familyName = "Reconstruction"
): OpenFace => {
  const byCharacter = new Map(
    glyphs.map((glyph, index) => [glyph.character, index + 1])
  );
  const average =
    glyphs.reduce((sum, glyph) => sum + glyph.advance, 0) /
    Math.max(1, glyphs.length);
  const missing: GlyphShape = {
    advance: Math.round(average),
    outline: EMPTY_OUTLINE,
  };
  const shapeOf = (glyphId: number): GlyphShape => {
    const glyph = glyphs[glyphId - 1];
    return glyph ? { advance: glyph.advance, outline: glyph.outline } : missing;
  };
  return {
    characters: () => Uint32Array.from([...byCharacter.keys()]).sort(),
    charactersForGlyph: (glyphId) => {
      const glyph = glyphs[glyphId - 1];
      return glyph ? [glyph.character] : [];
    },
    close: () => undefined,
    description: describe(familyName, glyphs.length, metrics),
    glyph: shapeOf,
    glyphForCharacter: (character) => byCharacter.get(character),
    glyphName: (glyphId) => {
      const glyph = glyphs[glyphId - 1];
      return glyph ? glyphNameFor(glyph.character) : ".notdef";
    },
    shape: (text, options) => {
      const shaped: ShapedGlyph[] = [];
      let cluster = 0;
      for (const character of text) {
        const glyphId = byCharacter.get(character.codePointAt(0) ?? 0) ?? 0;
        shaped.push({
          cluster,
          glyphId,
          xAdvance: shapeOf(glyphId).advance,
          xOffset: 0,
          yAdvance: 0,
          yOffset: 0,
        });
        cluster += character.length;
      }
      const rtl = options?.direction === "rtl";
      return {
        direction: rtl ? "rtl" : "ltr",
        glyphs: rtl ? shaped.toReversed() : shaped,
      };
    },
  };
};
