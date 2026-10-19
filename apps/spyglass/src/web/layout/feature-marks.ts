import { marshDetail, riverPen } from "../data/bindings";
import type { Territory } from "../data/types";
import { inkAlpha, inks } from "../ladder/ink-ladder";
import { inkStyle } from "../ladder/ink-table";
import { unit } from "./geography";
import type { Glyph, Mark, MarkAlpha, Stroke } from "./marks";
import { dashOf, glyphOn, internAlpha } from "./marks";
import type { NaturalFeature } from "./natural-feature-inspection";
import type { FeaturePoint, Marsh, NaturalFeatures } from "./natural-features";
import type { RiverRun } from "./river-network";

/** How strongly the features show at a zoom; the reveal is folded in by the caller. */
type FeatureStrength = (pixels: number) => number;

export interface FeatureMarkOptions {
  focus?: NaturalFeature;
  /** The island the features lie on; their coordinates are its. */
  on: Territory;
  /** The zoom the marks are built for: the pen and reed sizes follow it in world units. */
  pixels: number;
  streams: boolean;
  strength: FeatureStrength;
}

/** The zoom from which the marsh drains and the springs show. */
const drainsFrom = 3;
const springsFrom = 2;
/** The spring's arc: its radius and pen, in CSS pixels. */
const springRadius = 2.2;
const springPen = 0.7;

/** Stroke widths are rounded to this, so near-equal pens share a batch. */
const penStep = 0.05;
const roundPen = (width: number) => Math.round(width / penStep) * penStep;

/** One alpha per base and gate, shared by the marks that share it, so the renderer batches them. */
function alphaTable(strength: FeatureStrength) {
  const share = internAlpha();
  return (base: number, from = 0): MarkAlpha =>
    share(
      `${base}@${from}`,
      () => (pixels: number) => (pixels < from ? 0 : base * strength(pixels))
    );
}

type Alpha = ReturnType<typeof alphaTable>;

interface Placed {
  dx: number;
  dy: number;
  points: number[];
}
const flatRuns = new WeakMap<object, Placed>();
/** The glint's path, a hair off its river's, kept apart from it. */
const glintRuns = new WeakMap<object, Placed>();

/** A feature's points as one chart polyline, kept by the feature, so a rebuild keeps its draping. */
function pathOf(
  source: object,
  points: readonly FeaturePoint[],
  dx: number,
  dy: number,
  closed = false,
  kept = flatRuns
): number[] {
  const known = kept.get(source);
  if (known && known.dx === dx && known.dy === dy) {
    return known.points;
  }
  const flat: number[] = [];
  for (const point of points) {
    flat.push(point.x + dx, point.y + dy);
  }
  if (closed && points[0]) {
    flat.push(points[0].x + dx, points[0].y + dy);
  }
  kept.set(source, { dx, dy, points: flat });
  return flat;
}

/** A quadratic curve as a short polyline. */
function quadratic(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number
): number[] {
  const points: number[] = [];
  for (let step = 0; step <= 4; step += 1) {
    const t = step / 4;
    const a = (1 - t) ** 2;
    const b = 2 * (1 - t) * t;
    const c = t ** 2;
    points.push(a * x0 + b * cx + c * x1, a * y0 + b * cy + c * y1);
  }
  return points;
}

const reedCurves = new WeakMap<
  FeaturePoint,
  { size: number; curves: number[][] }
>();

/** One tuft of reeds: a bent base and three blades, each a short curve, at the tuft's size. */
function reedsOf(tuft: FeaturePoint, size: number, dx: number, dy: number) {
  const known = reedCurves.get(tuft);
  if (known && known.size === size) {
    return known.curves;
  }
  const lean = (unit(`${tuft.x}:${tuft.y}`) - 0.5) * 0.35;
  const x = tuft.x + dx;
  const y = tuft.y + dy;
  const curves = [
    quadratic(
      x - size * 0.85,
      y + size * 0.3,
      x,
      y + size * 0.4,
      x + size * 0.85,
      y + size * 0.22
    ),
  ];
  for (const offset of [-0.4, 0, 0.4]) {
    curves.push(
      quadratic(
        x + offset * size,
        y + size * 0.1,
        x + (offset + lean) * size,
        y - size * 0.2,
        x + (offset * 1.35 + lean) * size,
        y - size * (offset ? 0.4 : 0.75)
      )
    );
  }
  reedCurves.set(tuft, { curves, size });
  return curves;
}

function marshMarks(
  marshes: Marsh[],
  options: FeatureMarkOptions,
  alpha: Alpha
): Stroke[] {
  const { on, pixels } = options;
  const detail = marshDetail(marshes.length, pixels);
  const reedSize = Math.min(1, 5 / pixels);
  const reedPen = roundPen(Math.min(0.3 * pixels, 0.75));
  const drainPen = inkStyle("marsh-drain");
  const occupied: FeaturePoint[] = [];
  const marks: Stroke[] = [];
  for (const marsh of marshes) {
    const reedAlpha = alpha(0.65 * detail.opacity);
    for (const tuft of marsh.tufts) {
      if (
        occupied.some(
          (point) =>
            Math.hypot(point.x - tuft.x, point.y - tuft.y) < detail.spacing
        )
      ) {
        continue;
      }
      occupied.push(tuft);
      for (const points of reedsOf(tuft, reedSize, on.x, on.y)) {
        marks.push({
          alpha: reedAlpha,
          cap: "round",
          colour: inks.marsh,
          kind: "stroke",
          on,
          points,
          width: reedPen,
        });
      }
    }
    const drainAlpha = alpha(0.2 * detail.opacity, drainsFrom);
    for (const drain of marsh.drains) {
      marks.push({
        alpha: drainAlpha,
        cap: "round",
        colour: inks.marsh,
        dash: dashOf(drainPen),
        kind: "stroke",
        on,
        points: pathOf(drain, drain.points, on.x, on.y),
        width: 0.6,
      });
    }
  }
  return marks;
}

/** The glint's lie off the water, in CSS pixels east and south: a highlight on one bank. */
const glintNudge = { x: 0.65, y: 0.9 };

/**
 * Each river as three strokes: a broad dark bank and the water over one
 * path, and a pale glint a hair south-east of it. The glint's nudge is in
 * screen pixels, laid in world units at the zoom the marks are built for,
 * which is exact since the features are built again as the zoom changes.
 */
function streamMarks(
  runs: RiverRun[],
  options: FeatureMarkOptions,
  alpha: Alpha
): Stroke[] {
  const { on, pixels } = options;
  const marks: Stroke[] = [];
  for (const run of runs) {
    const points = pathOf(run, run.points, on.x, on.y);
    const glint = pathOf(
      run,
      run.points,
      on.x + glintNudge.x / pixels,
      on.y + glintNudge.y / pixels,
      false,
      glintRuns
    );
    const water = riverPen(run.width, pixels) * pixels;
    for (const [colour, base, width, path] of [
      [inks.streamBank, inkAlpha.streamBank, water + 5, points],
      [inks.streamGlint, inkAlpha.streamGlint, water + 1.3, glint],
      [inks.stream, 0.85, water, points],
    ] as const) {
      marks.push({
        alpha: alpha(base),
        cap: "round",
        colour,
        kind: "stroke",
        on,
        points: path,
        width: roundPen(width),
      });
    }
  }
  return marks;
}

/** A spring at each river's source, unless a landmark stands there: an arc open to the east. */
function springMarks(
  features: NaturalFeatures,
  options: FeatureMarkOptions,
  alpha: Alpha
): Glyph[] {
  const { on } = options;
  const landmarks = new Set(
    features.landmarks.map((landmark) => landmark.file.id)
  );
  const springs = new Map(
    features.streams.map((stream) => [stream.spring.id, stream.spring])
  );
  const springAlpha = alpha(0.75, springsFrom);
  const marks: Glyph[] = [];
  for (const spring of springs.values()) {
    if (landmarks.has(spring.id)) {
      continue;
    }
    marks.push(
      glyphOn(on, spring, {
        alpha: springAlpha,
        colour: inks.stream,
        shape: "spring",
        size: 2 * springRadius + springPen,
      })
    );
  }
  return marks;
}

/** A focused feature is a selection, drawn in the selection's ink. */
function focusMarks(options: FeatureMarkOptions): Stroke[] {
  const { focus, on, streams } = options;
  if (!focus || (focus.kind === "river" && !streams)) {
    return [];
  }
  let points: number[];
  if (focus.kind === "landmark") {
    points = pathOf(focus.landmark, focus.landmark.footprint, on.x, on.y, true);
  } else if (focus.kind === "river") {
    points = pathOf(focus.river, focus.river.points, on.x, on.y);
  } else {
    return [];
  }
  return [
    {
      alpha: 1,
      cap: "round",
      colour: inks.selection,
      kind: "stroke",
      on,
      points,
      width: inkStyle("selection").weight,
    },
  ];
}

/**
 * Static cartographic ink, draped on the island: reeds and drains for the
 * marshes, streams as bank, glint and water, a spring at each source, and
 * the focused feature's outline. Focus is the only amber in this
 * vocabulary. Every alpha follows the zoom through the strength; the pens
 * and the reeds are sized for the zoom the marks are built at.
 */
export function naturalFeatureMarks(
  features: NaturalFeatures,
  options: FeatureMarkOptions
): Mark[] {
  const alpha = alphaTable(options.strength);
  const marks: Mark[] = marshMarks(features.marshes, options, alpha);
  if (options.streams) {
    marks.push(
      ...streamMarks(features.rivers, options, alpha),
      ...springMarks(features, options, alpha)
    );
  }
  marks.push(...focusMarks(options));
  return marks;
}
