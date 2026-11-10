/**
 * Spacing arithmetic. The left bearing is the gap from the origin to the
 * outline, the right bearing the gap from the outline to the advance. Edits
 * keep whole font units.
 */
import { outlineBounds, translateOutline } from "~/typeface/outline";
import type { GlyphShape } from "~/typeface/reading";

export interface Bearings {
  readonly left: number;
  readonly right: number;
}

export type Measure = "advance" | "left" | "right";

/** Undefined for a glyph with nothing drawn, such as a space: it has an advance only. */
export const bearingsOf = (shape: GlyphShape): Bearings | undefined => {
  const bounds = outlineBounds(shape.outline);
  return bounds && { left: bounds.xMin, right: shape.advance - bounds.xMax };
};

/** Moves the right edge. The outline stays, so the right bearing takes the difference. */
export const withAdvance = (
  shape: GlyphShape,
  advance: number
): GlyphShape => ({
  ...shape,
  advance: Math.max(0, Math.round(advance)),
});

/**
 * Sets the gap before the outline. The outline moves and the advance moves
 * with it, so the right bearing is left as it was.
 */
export const withLeftBearing = (
  shape: GlyphShape,
  left: number
): GlyphShape => {
  const bearings = bearingsOf(shape);
  if (!bearings) {
    return shape;
  }
  const shift = Math.max(-shape.advance, Math.round(left - bearings.left));
  return shift === 0
    ? shape
    : {
        advance: shape.advance + shift,
        outline: translateOutline(shape.outline, shift, 0),
      };
};

/** Sets the gap after the outline by moving the advance. */
export const withRightBearing = (
  shape: GlyphShape,
  right: number
): GlyphShape => {
  const bearings = bearingsOf(shape);
  return bearings
    ? withAdvance(shape, shape.advance + right - bearings.right)
    : shape;
};

export const withMeasure = (
  shape: GlyphShape,
  measure: Measure,
  value: number
): GlyphShape => {
  if (measure === "advance") {
    return withAdvance(shape, value);
  }
  return measure === "left"
    ? withLeftBearing(shape, value)
    : withRightBearing(shape, value);
};

export const measureOf = (
  shape: GlyphShape,
  measure: Measure
): number | undefined =>
  measure === "advance" ? shape.advance : bearingsOf(shape)?.[measure];
