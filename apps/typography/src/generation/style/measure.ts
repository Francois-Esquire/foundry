/**
 * Measurements of one glyph's ink, taken from a rasterised copy so that
 * overlapping contours and either contour direction measure the same.
 */
import {
  type Bounds,
  type Outline,
  outlineBounds,
  transformOutline,
} from "~/typeface/outline";
import { flattenOutline } from "~/typeface/outline-geometry";
import { type Bitmap, inkAt } from "../raster/bitmap";
import {
  frameAround,
  type RasterFrame,
  rasterizeOutline,
} from "../raster/rasterize";

/** Pixels per em when measuring. A regular stem is then about 30 pixels wide. */
const MEASURE_EM = 400;
/** A run with no fully inked pixel only grazes the edge of a shape. */
const SOLID = 200;
/** No stroke is thicker than this share of the em, so longer runs follow a stroke lengthwise. */
const LONGEST_STROKE = 0.35;

export type EdgeShape = "diagonal" | "round" | "straight";

export interface InkMeasure {
  /** Ink area in square font units. */
  readonly area: number;
  readonly bounds: Bounds;
  /** Lengths of ink crossed along rows, in font units: the widths of upright strokes. */
  readonly horizontalRuns: readonly number[];
  /** Lengths of ink crossed along columns: the thicknesses of level strokes. */
  readonly verticalRuns: readonly number[];
}

const runsAlong = (
  count: number,
  length: number,
  valueAt: (line: number, position: number) => number,
  scale: number,
  longest: number
): number[] => {
  const runs: number[] = [];
  for (let line = 0; line < count; line += 1) {
    let sum = 0;
    let peak = 0;
    for (let position = 0; position <= length; position += 1) {
      const value = position < length ? valueAt(line, position) : 0;
      if (value > 0) {
        sum += value / 255;
        peak = Math.max(peak, value);
        continue;
      }
      if (peak >= SOLID && sum / scale <= longest) {
        runs.push(sum / scale);
      }
      sum = 0;
      peak = 0;
    }
  }
  return runs;
};

const areaOf = (bitmap: Bitmap, scale: number): number => {
  let covered = 0;
  for (const value of bitmap.data) {
    covered += value / 255;
  }
  return covered / (scale * scale);
};

/** Measures the ink of an outline, or nothing for an empty one. */
export const measureInk = (
  outline: Outline,
  unitsPerEm: number
): InkMeasure | undefined => {
  const bounds = outlineBounds(outline);
  if (!bounds) {
    return;
  }
  const scale = MEASURE_EM / unitsPerEm;
  const bitmap = rasterizeOutline(outline, frameAround(bounds, scale), {
    antialias: true,
  });
  const longest = LONGEST_STROKE * unitsPerEm;
  return {
    area: areaOf(bitmap, scale),
    bounds,
    horizontalRuns: runsAlong(
      bitmap.height,
      bitmap.width,
      (row, column) => inkAt(bitmap, column, row),
      scale,
      longest
    ),
    verticalRuns: runsAlong(
      bitmap.width,
      bitmap.height,
      (column, row) => inkAt(bitmap, column, row),
      scale,
      longest
    ),
  };
};

/**
 * The most common length among many, to within `resolution`: the peak of
 * their histogram, then the mean of the lengths around that peak. Straight
 * strokes repeat one length over and over, while curves spread theirs out.
 */
export const dominantLength = (
  lengths: readonly number[],
  resolution: number
): number | undefined => {
  const bins = new Map<number, number>();
  for (const length of lengths) {
    const bin = Math.round(length / resolution);
    if (bin >= 2) {
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
    }
  }
  let peak: number | undefined;
  let peakWeight = 0;
  for (const bin of bins.keys()) {
    const weight =
      (bins.get(bin - 1) ?? 0) +
      2 * (bins.get(bin) ?? 0) +
      (bins.get(bin + 1) ?? 0);
    if (weight > peakWeight) {
      peak = bin;
      peakWeight = weight;
    }
  }
  if (peak === undefined) {
    return;
  }
  const centre = peak * resolution;
  const near = lengths.filter(
    (length) => Math.abs(length - centre) <= Math.max(resolution, centre * 0.12)
  );
  return near.reduce((sum, length) => sum + length, 0) / near.length;
};

/** The resolution `dominantLength` should use for runs from `measureInk`. */
export const measureResolution = (unitsPerEm: number) =>
  unitsPerEm / MEASURE_EM;

export const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) {
    return;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1
    ? upper
    : ((sorted[middle - 1] ?? upper) + upper) / 2;
};

/** The value below which the given share of the values fall. */
export const quantile = (values: readonly number[], share: number): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(share * (sorted.length - 1)))
  );
  return sorted[index] ?? 0;
};

/** The transform that stands a slanted outline upright, pivoting on the baseline. */
const uprightTransform = (slantDegrees: number) => ({
  dx: 0,
  dy: 0,
  xx: 1,
  xy: 0,
  yx: -Math.tan((slantDegrees * Math.PI) / 180),
  yy: 1,
});

const EDGE_ROWS = 96;
/** Rows this close to the outermost ink, as a share of the height, lie on the edge. */
const ON_EDGE = 0.02;
const STRAIGHT_SHARE = 0.5;
const RECEDES = 0.06;

const edgeProfile = (
  bitmap: Bitmap,
  frame: RasterFrame,
  side: "left" | "right"
): number[] => {
  const profile: number[] = [];
  for (let row = 0; row < frame.height; row += 1) {
    let found: number | undefined;
    for (let step = 0; step < frame.width && found === undefined; step += 1) {
      const column = side === "left" ? step : frame.width - 1 - step;
      if (inkAt(bitmap, column, row) >= 128) {
        found = step;
      }
    }
    if (found !== undefined) {
      profile.push(found);
    }
  }
  return profile;
};

const classifyProfile = (profile: readonly number[]): EdgeShape => {
  const rows = profile.length;
  const outermost = Math.min(...profile);
  const near = profile.map((depth) => depth - outermost <= ON_EDGE * rows);
  const onEdge = near.filter(Boolean).length;
  if (onEdge >= STRAIGHT_SHARE * rows) {
    return "straight";
  }
  const band = Math.max(1, Math.round(rows * 0.1));
  const mean = (values: readonly number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length - outermost;
  const top = mean(profile.slice(0, band));
  const bottom = mean(profile.slice(rows - band));
  const centre =
    near.reduce((sum, isNear, row) => sum + (isNear ? row : 0), 0) / onEdge;
  const centred = centre > rows * 0.2 && centre < rows * 0.8;
  return centred && top >= RECEDES * rows && bottom >= RECEDES * rows
    ? "round"
    : "diagonal";
};

/**
 * Whether each side of a glyph ends in a straight stem, a round bowl, or a
 * diagonal or open shape. Spacing depends on this far more than on which
 * script the glyph belongs to.
 */
export const edgeShapes = (
  outline: Outline,
  slantDegrees = 0
): { readonly left: EdgeShape; readonly right: EdgeShape } | undefined => {
  const upright = transformOutline(outline, uprightTransform(slantDegrees));
  const bounds = outlineBounds(upright);
  if (!bounds || bounds.yMax <= bounds.yMin) {
    return;
  }
  const frame = frameAround(bounds, EDGE_ROWS / (bounds.yMax - bounds.yMin), 0);
  const bitmap = rasterizeOutline(upright, frame);
  const left = edgeProfile(bitmap, frame, "left");
  const right = edgeProfile(bitmap, frame, "right");
  return left.length === 0 || right.length === 0
    ? undefined
    : { left: classifyProfile(left), right: classifyProfile(right) };
};

/**
 * The same for the head and foot of a glyph. A round head or foot is one
 * that overshoots the line a flat one stops at.
 */
export const headAndFoot = (
  outline: Outline
): { readonly foot: EdgeShape; readonly head: EdgeShape } | undefined => {
  const turned = transformOutline(outline, {
    dx: 0,
    dy: 0,
    xx: 0,
    xy: 1,
    yx: 1,
    yy: 0,
  });
  const edges = edgeShapes(turned);
  return edges && { foot: edges.left, head: edges.right };
};

const SLANT_LIMIT = 30;
const SLANT_STEP = 0.5;

/**
 * The lean of the upright strokes, in degrees clockwise from vertical. Edges
 * of straight stems all point the same way, so the busiest direction among
 * the near-vertical edges is the slant.
 */
export const slantOf = (outlines: readonly Outline[]): number => {
  const weights = new Map<number, number>();
  for (const outline of outlines) {
    for (const polygon of flattenOutline(outline, 0.5)) {
      let from = polygon.at(-1);
      for (const to of polygon) {
        if (from) {
          const rise = Math.abs(to.y - from.y);
          const run = (to.x - from.x) * Math.sign(to.y - from.y);
          const lean = (Math.atan2(run, rise) * 180) / Math.PI;
          if (rise > 0 && Math.abs(lean) <= SLANT_LIMIT) {
            const bin = Math.round(lean / SLANT_STEP);
            weights.set(bin, (weights.get(bin) ?? 0) + Math.hypot(run, rise));
          }
        }
        from = to;
      }
    }
  }
  let best = 0;
  let bestWeight = 0;
  for (const [bin, weight] of weights) {
    if (weight > bestWeight) {
      best = bin;
      bestWeight = weight;
    }
  }
  return best * SLANT_STEP;
};
