/**
 * Derivatives a typographic convention supports: a glyph transformed as a
 * whole. They are quick stand-ins, and each says what a designer would fix.
 */
import { type Outline, transformOutline } from "~/typeface/outline";
import type { GlyphShape } from "~/typeface/reading";
import type { StyleReference } from "../../style/reference";

export interface Derivative {
  readonly advance: number;
  readonly outline: Outline;
  readonly rule: string;
  readonly weaknesses: readonly string[];
}

/** Small capitals are drawn a little wider than a plain reduction of the capital. */
const SMALL_CAPITAL_WIDENING = 1.06;

/** Slants a glyph by shearing it about the baseline. The advance does not change. */
export const obliqueOf = (shape: GlyphShape, angle: number): Derivative => ({
  advance: shape.advance,
  outline: transformOutline(shape.outline, {
    dx: 0,
    dy: 0,
    xx: 1,
    xy: 0,
    yx: Math.tan((angle * Math.PI) / 180),
    yy: 1,
  }),
  rule: `Oblique: the source glyph sheared ${angle} degrees about the baseline.`,
  weaknesses: [
    "A shear thins strokes that lean with it and thickens those that lean against it, and it skews round shapes. A drawn italic corrects both.",
  ],
});

/** Scales a capital down to the x-height. */
export const smallCapitalOf = (
  capital: GlyphShape,
  style: StyleReference
): Derivative => {
  const vertical = style.metrics.xHeight / style.metrics.capHeight;
  const horizontal = vertical * SMALL_CAPITAL_WIDENING;
  const stem = Math.round(style.stems.vertical * horizontal);
  return {
    advance: capital.advance * horizontal,
    outline: transformOutline(capital.outline, {
      dx: 0,
      dy: 0,
      xx: horizontal,
      xy: 0,
      yx: 0,
      yy: vertical,
    }),
    rule: `Small capital: the capital scaled to the x-height (${Math.round(vertical * 100)}% tall, ${Math.round(horizontal * 100)}% wide).`,
    weaknesses: [
      `Stems are not compensated: they scale to about ${stem} units against ${Math.round(style.stems.vertical)} in the face, so the small capital reads lighter than the lowercase beside it.`,
    ],
  };
};
