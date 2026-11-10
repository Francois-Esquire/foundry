/**
 * A set line as boxes for inspection: one box per glyph, with the characters
 * of the cluster it came from. A ligature is one box for several characters;
 * a decomposed or reordered syllable is several boxes for one cluster.
 */
import type { GlyphRef } from "~/typeface/changes";
import type { Outline } from "~/typeface/outline";
import type { SetLine } from "~/typeface/typesetting";

export interface GlyphBox {
  readonly advance: number;
  /** Index of the first UTF-16 code unit of the cluster. */
  readonly cluster: number;
  /** The cluster's place in reading order, counted from 1. */
  readonly clusterNumber: number;
  /** True when the box before it on the line belongs to another cluster. */
  readonly clusterStart: boolean;
  readonly missing: boolean;
  readonly outline: Outline;
  readonly ref: GlyphRef;
  /** The characters of the cluster, in the order they were typed. */
  readonly text: string;
  /** Where the box starts on the line, in font units. */
  readonly x: number;
  /** How far the glyph is moved from the pen position, as by a mark anchor. */
  readonly xOffset: number;
  readonly yOffset: number;
}

export const boxesOf = (text: string, line: SetLine): GlyphBox[] => {
  const starts = [...new Set(line.glyphs.map((glyph) => glyph.cluster))].sort(
    (a, b) => a - b
  );
  let pen = 0;
  return line.glyphs.map((glyph, index) => {
    const order = starts.indexOf(glyph.cluster);
    const box: GlyphBox = {
      advance: glyph.advance,
      cluster: glyph.cluster,
      clusterNumber: order + 1,
      clusterStart: line.glyphs[index - 1]?.cluster !== glyph.cluster,
      missing: glyph.missing,
      outline: glyph.outline,
      ref: glyph.ref,
      text: text.slice(glyph.cluster, starts[order + 1] ?? text.length),
      x: pen,
      xOffset: glyph.x - pen,
      yOffset: glyph.y,
    };
    pen += glyph.advance;
    return box;
  });
};
