import type { Polygon, Territory } from "../data/types";

/**
 * The vocabulary of drawable things, from `docs/spyglass/_renderer.md`: a
 * layer decides what to draw from the repaint's state and returns these; the
 * renderers in `scene/marks/` draw them. A mark names its ink by the
 * ladder's colour and alpha, never a hue of its own, and sits either flat on
 * the sea plane or draped on one island's relief.
 */

/**
 * How opaque a mark is: a number, or a function of the view's pixels per
 * unit for the inks that surface with zoom. A function is evaluated every
 * frame as a uniform, so a mark whose alpha changes with the view is still
 * static geometry. Share one function between marks that share an alpha,
 * since the renderer batches by its identity.
 */
export type MarkAlpha = number | ((pixelsPerUnit: number) => number);

interface MarkBase {
  alpha: MarkAlpha;
  /** A ladder ink. */
  colour: string;
  /** The island whose relief the mark is draped on; without one it lies flat on the sea plane. */
  on?: Territory;
}

/** A polyline with a screen-space width. */
export interface Stroke extends MarkBase {
  cap?: "butt" | "round";
  /** Dash and gap, in CSS pixels; solid without. */
  dash?: readonly [number, number];
  kind: "stroke";
  /** The polyline as x, y pairs in chart units. */
  points: readonly number[];
  /** CSS pixels. */
  width: number;
}

/** A filled polygon: the outer ring first, then its holes. */
export interface Fill extends MarkBase {
  kind: "fill";
  polygon: Polygon;
}

export type GlyphShape = "diamond" | "dot" | "notchedRing" | "ring" | "tick";

/** A mark at a point, sized in screen space. */
export interface Glyph extends MarkBase {
  kind: "glyph";
  shape: GlyphShape;
  /** The glyph's diameter in CSS pixels. */
  size: number;
  x: number;
  y: number;
}

export type Mark = Fill | Glyph | Stroke;

/** The alpha a mark takes at this zoom. */
export function alphaAt(alpha: MarkAlpha, pixelsPerUnit: number): number {
  return typeof alpha === "number" ? alpha : alpha(pixelsPerUnit);
}

/** A ring's points as one flat polyline, offset to the chart. */
export function ringPoints(
  ring: readonly (readonly [number, number])[],
  dx = 0,
  dy = 0
): number[] {
  const points: number[] = [];
  for (const [x, y] of ring) {
    points.push(x + dx, y + dy);
  }
  return points;
}

/** A pen run (x, y pairs) offset to the chart. */
export function runPoints(run: readonly number[], dx = 0, dy = 0): number[] {
  const points: number[] = [];
  for (let i = 0; i + 1 < run.length; i += 2) {
    points.push((run[i] ?? 0) + dx, (run[i + 1] ?? 0) + dy);
  }
  return points;
}
