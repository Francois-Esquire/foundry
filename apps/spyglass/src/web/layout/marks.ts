import type { Polygon, Territory } from "../data/types";
import type { InkStyle } from "../ladder/ink-table";

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

/**
 * A glyph's size in CSS pixels: a number, or a function of pixels per unit
 * for a mark whose screen size follows the zoom, as a file mark's does. A
 * function is read each frame into the batch's size uniform, so the layer
 * never rebuilds for a zoom; share one between the glyphs that share it,
 * since the renderer batches by its identity.
 */
export type MarkSize = number | ((pixelsPerUnit: number) => number);

interface MarkBase {
  alpha: MarkAlpha;
  /** A ladder ink. */
  colour: string;
  /** The island whose relief the mark is draped on; without one it lies flat on the sea plane. */
  on?: Territory;
  /**
   * Compositing group within a layer, lowest first; 0 by default. Marks
   * within a group batch by kind and style. Use successive groups when a
   * later fill must cover an earlier stroke.
   */
  order?: number;
}

/** A stroke's dash: dash and gap, or dash, gap, dot and gap. */
export type StrokeDash =
  | readonly [number, number]
  | readonly [number, number, number, number];

/** A polyline with a screen-space width. */
export interface Stroke extends Omit<MarkBase, "on"> {
  cap?: "butt" | "round";
  /**
   * Dash and gap, in CSS pixels, or a dash, a gap, a dot and a gap for a
   * dash-dot line; solid without. A dash shorter than the stroke's width is
   * drawn the width long, as a round-capped dot was, keeping the period.
   */
  dash?: StrokeDash;
  kind: "stroke";
  /**
   * As every mark, draped on one island; or, for a line that crosses between
   * islands, on the chart: each vertex lifted onto whatever lies under it,
   * an island's relief or the sea plane.
   */
  on?: Territory | "chart";
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

/**
 * The shapes, each at unit size about its centre, north up. `frame` is a
 * hollow square whose outer edge is the size and whose band is the glyph's
 * `weight`; `spring` a ring open to the east. The banded shapes below draw
 * their band astride the shape's edge, as a stroked path does, so their size
 * is the painter's own: `hoop`, a ring of the size's diameter; `cross`, a
 * plus spanning the size; `notch`, a bar from the centre toward the
 * north-east; `closeMark`, the "( )" of two arcs set apart; `notchedRing`, a
 * ring open at the north by the ladder's departure notch, and `notchPlug`,
 * the arc that closes it. The file marks:
 * `file`, a filled rect one wide and one and a half tall, hanging south of
 * its point; `testFile`, the same rect hollow, with a plug; `halfDisc`, the
 * southern half of a disc; `mixed`, a filled bar west of a hollow one.
 */
export type GlyphShape =
  | "closeMark"
  | "cross"
  | "diamond"
  | "dot"
  | "file"
  | "frame"
  | "halfDisc"
  | "hoop"
  | "mixed"
  | "notch"
  | "notchPlug"
  | "notchedRing"
  | "ring"
  | "spring"
  | "square"
  | "testFile"
  | "tick";

/** A mark at a point, sized in screen space. */
export interface Glyph extends MarkBase {
  kind: "glyph";
  /** A nudge from the point in CSS pixels, east and south, applied at the zoom. */
  offset?: readonly [number, number];
  shape: GlyphShape;
  /** The glyph's diameter in CSS pixels, or a function of the zoom for one that follows it. */
  size: MarkSize;
  /**
   * Stretched north–south by the tilt's foreshortening, so the shape reads
   * round or square on screen; without it the glyph lies in the ground plane
   * and is foreshortened with it.
   */
  upright?: true;
  /** The band of a hollow shape, in CSS pixels; a filled shape ignores it. */
  weight?: number;
  x: number;
  y: number;
}

export type Mark = Fill | Glyph | Stroke;

/** The alpha a mark takes at this zoom. */
export function alphaAt(alpha: MarkAlpha, pixelsPerUnit: number): number {
  return typeof alpha === "number" ? alpha : alpha(pixelsPerUnit);
}

/** A ladder row's dash as a stroke takes it: dash and gap, dash-dot, or solid. */
export function dashOf(style: {
  dash: readonly number[];
}): StrokeDash | undefined {
  const [dash, gap, dot, rest] = style.dash;
  if (dash === undefined || gap === undefined) {
    return undefined;
  }
  return dot !== undefined && rest !== undefined
    ? [dash, gap, dot, rest]
    : [dash, gap];
}

/** The size a glyph takes at this zoom, in CSS pixels. */
export function sizeAt(size: MarkSize, pixelsPerUnit: number): number {
  return typeof size === "number" ? size : size(pixelsPerUnit);
}

/** What a ladder row says about a stroke: its hue, weight and dash. */
type StrokeInk = Pick<InkStyle, "dash" | "hue" | "weight">;

/** What a stroke takes beside its row: the alpha (opaque without), and the cap, colour, plane and width where a site has its own. */
interface InkedStrokeOptions {
  alpha?: MarkAlpha;
  cap?: Stroke["cap"];
  /** Another ink than the row's hue, as the selection's lines take the selection's. */
  colour?: string;
  on?: Stroke["on"];
  /** A width of the site's own, as a pen under pressure has, instead of the row's weight. */
  width?: number;
}

/**
 * A stroke in a ladder row's ink: the row's hue, weight and dash, over the
 * given points. The cap and plane are the site's, passed through as given,
 * since the renderer batches by both and reads an absent cap as round.
 */
export function inkedStroke(
  style: StrokeInk,
  points: readonly number[],
  options: InkedStrokeOptions = {}
): Stroke {
  const {
    alpha = 1,
    cap,
    colour = style.hue,
    on,
    width = style.weight,
  } = options;
  return {
    alpha,
    cap,
    colour,
    dash: dashOf(style),
    kind: "stroke",
    on,
    points,
    width,
  };
}

/** A glyph at an island-local point, draped on the island: the point moved onto the chart by the island's position. */
export function glyphOn(
  territory: Territory,
  point: { x: number; y: number },
  rest: Omit<Glyph, "kind" | "on" | "x" | "y">
): Glyph {
  return {
    ...rest,
    kind: "glyph",
    on: territory,
    x: territory.x + point.x,
    y: territory.y + point.y,
  };
}

/**
 * One alpha function per key, shared by every mark that asks for the key,
 * so the renderer batches them by its identity. The curve is the caller's;
 * only the interning is shared.
 */
export function internAlpha<Key = string>(): (
  key: Key,
  make: () => MarkAlpha
) => MarkAlpha {
  const alphas = new Map<Key, MarkAlpha>();
  return (key, make) => {
    let alpha = alphas.get(key);
    if (!alpha) {
      alpha = make();
      alphas.set(key, alpha);
    }
    return alpha;
  };
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

/** What a translation left: the move, and the result at it. */
interface Placed<T> {
  dx: number;
  dy: number;
  result: T;
}

const placedPolygons = new WeakMap<Polygon[], Placed<Polygon[]>>();
const placedPolylines = new WeakMap<number[][], Placed<number[][]>>();

/**
 * Island-local polygons moved onto the chart. Kept by the polygons' identity
 * and the move, so a rebuild hands the renderer the same polygons and it
 * keeps their draping.
 */
export function placePolygons(
  polygons: Polygon[],
  dx: number,
  dy: number
): Polygon[] {
  const known = placedPolygons.get(polygons);
  if (known && known.dx === dx && known.dy === dy) {
    return known.result;
  }
  const result = polygons.map((polygon) =>
    polygon.map((ring) =>
      ring.map(([x, y]): [number, number] => [x + dx, y + dy])
    )
  );
  placedPolygons.set(polygons, { dx, dy, result });
  return result;
}

/** Island-local polylines moved onto the chart, kept as `placePolygons` keeps polygons. */
export function placePolylines(
  polylines: number[][],
  dx: number,
  dy: number
): number[][] {
  const known = placedPolylines.get(polylines);
  if (known && known.dx === dx && known.dy === dy) {
    return known.result;
  }
  const result = polylines.map((points) => runPoints(points, dx, dy));
  placedPolylines.set(polylines, { dx, dy, result });
  return result;
}
