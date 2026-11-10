/** Sets a glyph's sidebearings and advance from the face's spacing, by the shape of each edge. */
import {
  type Outline,
  outlineBounds,
  translateOutline,
} from "~/typeface/outline";
import { type EdgeShape, edgeShapes } from "../style/measure";
import type { StyleReference } from "../style/reference";

export interface Spaced {
  readonly advance: number;
  readonly edges: { readonly left: EdgeShape; readonly right: EdgeShape };
  readonly outline: Outline;
}

/** An edge too small to classify is spaced like an open shape. */
const UNCLEAR: EdgeShape = "diagonal";

/**
 * Moves the outline so its left bearing matches the face's bearing for that
 * kind of edge, and sets the advance from the right bearing the same way.
 */
export const spaceGlyph = (outline: Outline, style: StyleReference): Spaced => {
  const bounds = outlineBounds(outline);
  const edges = edgeShapes(outline, style.slant) ?? {
    left: UNCLEAR,
    right: UNCLEAR,
  };
  if (!bounds) {
    return { advance: Math.round(style.averageAdvance), edges, outline };
  }
  const left = Math.round(style.sidebearings[edges.left]);
  const right = Math.round(style.sidebearings[edges.right]);
  return {
    advance: left + Math.round(bounds.xMax - bounds.xMin) + right,
    edges,
    outline: translateOutline(outline, left - bounds.xMin, 0),
  };
};
