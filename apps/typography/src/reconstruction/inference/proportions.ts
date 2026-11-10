/**
 * Width against the observed letters. A model asked to complete an alphabet
 * can match the weight and miss the width, and nothing in a per-glyph style
 * check shows it. Plain width over height will not do either: it depends on
 * which letters each set holds, I against M. So each letter is measured
 * against the same letter of one reference face, and the two sets are
 * compared by how far each departs from that face.
 */
import { median } from "~/generation/style/measure";
import { type Outline, outlineBounds } from "~/typeface/outline";
import type { ReferenceFace } from "../recognition/face-recognizer";

export interface ProportionedGlyph {
  readonly character: number;
  readonly outline: Outline;
}

interface GlyphProportion {
  readonly character: number;
  /** Ink width over ink height. */
  readonly proportion: number;
  /** The proportion over the same letter's in the reference face. Absent when that face lacks the letter. */
  readonly relative?: number;
}

export interface WidthComparison {
  /**
   * `reference-face`: the medians are of widths relative to the same letters
   * in the reference face, so they compare like with like. `ink-proportion`:
   * no reference face covered both sets, the medians are plain width over
   * height, and the letter mix of each set is part of the difference.
   */
  readonly basis: "ink-proportion" | "reference-face";
  readonly inferred: readonly GlyphProportion[];
  readonly inferredMiddle: number;
  readonly observed: readonly GlyphProportion[];
  readonly observedMiddle: number;
  /** The inferred middle over the observed one. 1.2 reads as: the inferred letters are a fifth wider. */
  readonly ratio: number;
}

const proportionOf = (outline: Outline): number | undefined => {
  const bounds = outlineBounds(outline);
  const height = bounds ? bounds.yMax - bounds.yMin : 0;
  return bounds && height > 0
    ? (bounds.xMax - bounds.xMin) / height
    : undefined;
};

const measure = (
  glyphs: readonly ProportionedGlyph[],
  reference: ReferenceFace | undefined
): GlyphProportion[] =>
  glyphs.flatMap(({ character, outline }): GlyphProportion[] => {
    const proportion = proportionOf(outline);
    if (proportion === undefined) {
      return [];
    }
    const glyphId = reference?.face.glyphForCharacter(character);
    const own =
      reference && glyphId !== undefined
        ? proportionOf(
            reference.face.glyph(glyphId, reference.location).outline
          )
        : undefined;
    return [
      { character, proportion, relative: own ? proportion / own : undefined },
    ];
  });

const relatives = (glyphs: readonly GlyphProportion[]): number[] =>
  glyphs.flatMap((glyph) =>
    glyph.relative === undefined ? [] : [glyph.relative]
  );

/** Compares the widths of inferred glyphs with the widths of the observed ones. */
export const compareWidths = (
  observedGlyphs: readonly ProportionedGlyph[],
  inferredGlyphs: readonly ProportionedGlyph[],
  reference?: ReferenceFace
): WidthComparison => {
  const observed = measure(observedGlyphs, reference);
  const inferred = measure(inferredGlyphs, reference);
  const likeWithLike =
    relatives(observed).length > 0 && relatives(inferred).length > 0;
  const middleOf = (glyphs: readonly GlyphProportion[]) =>
    median(
      likeWithLike ? relatives(glyphs) : glyphs.map((glyph) => glyph.proportion)
    ) ?? 0;
  const observedMiddle = middleOf(observed);
  const inferredMiddle = middleOf(inferred);
  return {
    basis: likeWithLike ? "reference-face" : "ink-proportion",
    inferred,
    inferredMiddle,
    observed,
    observedMiddle,
    ratio: observedMiddle > 0 ? inferredMiddle / observedMiddle : 0,
  };
};
