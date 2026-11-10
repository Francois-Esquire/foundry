/**
 * Fills an outline into a bitmap with the non-zero winding rule, the rule
 * font renderers use, so overlapping contours stay solid.
 */
import {
  type Bounds,
  type Outline,
  type Point,
  type Transform,
  transformOutline,
} from "~/typeface/outline";
import { type Bitmap, createBitmap, INK_THRESHOLD } from "./bitmap";
import { flattenOutline } from "./flatten";

/**
 * Where a bitmap sits in outline space. Pixel column x covers outline x from
 * `left + x / scale`, and pixel row y hangs below outline y `top - y / scale`.
 */
export interface RasterFrame {
  readonly height: number;
  readonly left: number;
  /** Pixels per outline unit. */
  readonly scale: number;
  readonly top: number;
  readonly width: number;
}

export interface RasterizeOptions {
  /** Grey edge pixels by coverage. Without it every pixel is ink or paper. */
  readonly antialias?: boolean;
}

const SUBSAMPLES = 8;

/** A frame that holds the bounds with a margin of whole pixels around them. */
export const frameAround = (
  bounds: Bounds,
  scale: number,
  margin = 2
): RasterFrame => ({
  height: Math.ceil((bounds.yMax - bounds.yMin) * scale) + 2 * margin,
  left: bounds.xMin - margin / scale,
  scale,
  top: bounds.yMax + margin / scale,
  width: Math.ceil((bounds.xMax - bounds.xMin) * scale) + 2 * margin,
});

/** Outline units to pixel positions, with y turned to point down. */
export const frameTransform = (frame: RasterFrame): Transform => ({
  dx: -frame.left * frame.scale,
  dy: frame.top * frame.scale,
  xx: frame.scale,
  xy: 0,
  yx: 0,
  yy: -frame.scale,
});

/**
 * Traced coordinates back to outline units. A tracer answers in pixels with
 * y up from the bottom edge of the bitmap.
 */
export const tracedToOutline = (frame: RasterFrame): Transform => ({
  dx: frame.left,
  dy: frame.top - frame.height / frame.scale,
  xx: 1 / frame.scale,
  xy: 0,
  yx: 0,
  yy: 1 / frame.scale,
});

interface Edge {
  /** +1 when the edge runs down the bitmap, -1 when it runs up. */
  readonly direction: number;
  readonly slope: number;
  readonly x0: number;
  readonly y0: number;
  readonly y1: number;
}

const edgesOf = (polygons: readonly Point[][]): Edge[] => {
  const edges: Edge[] = [];
  for (const polygon of polygons) {
    let from = polygon.at(-1);
    for (const to of polygon) {
      if (from && from.y !== to.y) {
        const down = to.y > from.y;
        const upper = down ? from : to;
        const lower = down ? to : from;
        edges.push({
          direction: down ? 1 : -1,
          slope: (lower.x - upper.x) / (lower.y - upper.y),
          x0: upper.x,
          y0: upper.y,
          y1: lower.y,
        });
      }
      from = to;
    }
  }
  return edges;
};

/** Edges by the pixel rows they touch, so a scanline only meets its own. */
const bucketByRow = (edges: readonly Edge[], height: number): Edge[][] => {
  const rows: Edge[][] = Array.from({ length: height }, () => []);
  for (const edge of edges) {
    const first = Math.max(0, Math.floor(edge.y0));
    const last = Math.min(height - 1, Math.floor(edge.y1));
    for (let row = first; row <= last; row += 1) {
      rows[row]?.push(edge);
    }
  }
  return rows;
};

interface Crossing {
  readonly direction: number;
  readonly x: number;
}

const crossingsAt = (edges: readonly Edge[], y: number): Crossing[] => {
  const crossings: Crossing[] = [];
  for (const edge of edges) {
    if (y >= edge.y0 && y < edge.y1) {
      crossings.push({
        direction: edge.direction,
        x: edge.x0 + (y - edge.y0) * edge.slope,
      });
    }
  }
  return crossings.sort((a, b) => a.x - b.x);
};

/** Adds the share of each pixel that the span from x0 to x1 covers. */
const coverSpan = (
  coverage: Float32Array,
  width: number,
  from: number,
  to: number
) => {
  const x0 = Math.max(0, from);
  const x1 = Math.min(width, to);
  if (x1 <= x0) {
    return;
  }
  const first = Math.floor(x0);
  const last = Math.min(width - 1, Math.floor(x1));
  if (first === last) {
    coverage[first] = (coverage[first] ?? 0) + (x1 - x0);
    return;
  }
  coverage[first] = (coverage[first] ?? 0) + (first + 1 - x0);
  for (let x = first + 1; x < last; x += 1) {
    coverage[x] = (coverage[x] ?? 0) + 1;
  }
  coverage[last] = (coverage[last] ?? 0) + (x1 - last);
};

const coverScanline = (
  coverage: Float32Array,
  width: number,
  crossings: readonly Crossing[]
) => {
  let winding = 0;
  let spanStart = 0;
  for (const crossing of crossings) {
    const before = winding;
    winding += crossing.direction;
    if (before === 0 && winding !== 0) {
      spanStart = crossing.x;
    } else if (before !== 0 && winding === 0) {
      coverSpan(coverage, width, spanStart, crossing.x);
    }
  }
};

const solid = (level: number) => (level >= INK_THRESHOLD ? 255 : 0);

/** Fills polygons given in pixel coordinates with y down. */
export const rasterizePolygons = (
  polygons: readonly Point[][],
  width: number,
  height: number,
  options: RasterizeOptions = {}
): Bitmap => {
  const bitmap = createBitmap(width, height);
  const rows = bucketByRow(edgesOf(polygons), bitmap.height);
  const samples = options.antialias ? SUBSAMPLES : 1;
  const coverage = new Float32Array(bitmap.width);
  for (let row = 0; row < bitmap.height; row += 1) {
    const edges = rows[row] ?? [];
    if (edges.length === 0) {
      continue;
    }
    coverage.fill(0);
    for (let sample = 0; sample < samples; sample += 1) {
      const y = row + (sample + 0.5) / samples;
      coverScanline(coverage, bitmap.width, crossingsAt(edges, y));
    }
    for (let x = 0; x < bitmap.width; x += 1) {
      const level = Math.round((255 * (coverage[x] ?? 0)) / samples);
      bitmap.data[row * bitmap.width + x] = options.antialias
        ? level
        : solid(level);
    }
  }
  return bitmap;
};

/** Fills an outline into a bitmap placed by the frame. */
export const rasterizeOutline = (
  outline: Outline,
  frame: RasterFrame,
  options: RasterizeOptions = {}
): Bitmap =>
  rasterizePolygons(
    flattenOutline(transformOutline(outline, frameTransform(frame)), 0.05),
    frame.width,
    frame.height,
    options
  );
