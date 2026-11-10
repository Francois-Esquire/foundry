/**
 * Sets a text in a built font's own outlines: shaped by the font's own
 * rules, each glyph where shaping put it. The result is plain data, so the
 * font can be closed once its lines are set.
 */
import { outlineToPath } from "~/typeface/outline";
import type { OpenFace } from "~/typeface/reading";

interface SetGlyph {
  /** True for a glyph the project added, false for one of the source font's. */
  readonly added: boolean;
  /** The outline as an SVG path, in font units with y up. */
  readonly path: string;
  readonly x: number;
  readonly y: number;
}

export interface SetLine {
  readonly glyphs: readonly SetGlyph[];
  readonly text: string;
  /** The sum of the advances. */
  readonly width: number;
}

export interface SetLineOptions {
  /** The id of the first added glyph: the source font's glyph count. */
  readonly firstAdded: number;
  /** ISO 15924 script, for example Deva. Guessed from the text when absent. */
  readonly script?: string;
}

export const setLine = (
  face: OpenFace,
  text: string,
  { firstAdded, script }: SetLineOptions
): SetLine => {
  let pen = 0;
  const glyphs: SetGlyph[] = [];
  for (const shaped of face.shape(text, script ? { script } : {}).glyphs) {
    const path = outlineToPath(face.glyph(shaped.glyphId).outline);
    if (path) {
      glyphs.push({
        added: shaped.glyphId >= firstAdded,
        path,
        x: pen + shaped.xOffset,
        y: shaped.yOffset,
      });
    }
    pen += shaped.xAdvance;
  }
  return { glyphs, text, width: pen };
};
