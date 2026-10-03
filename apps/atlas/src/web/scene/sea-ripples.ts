import { contours } from "d3-contour";
import type { AtlasData, Polygon } from "../types";
import type { InkView } from "./exploration";
import { oceanField } from "./ocean";
import { penRuns, penWeights, strokeRuns } from "./paint-paper";

/** Offshore distances of the gilded ripples, in map units. */
const rippleOffsets = [2.4, 4.8, 7.6];
const rippleOpacity = [0.16, 0.11, 0.07];
/** Below this pressure the pen lifts, so ripples are broken lines. */
const rippleLift = 0.28;

export interface SeaRipple {
  box: [number, number, number, number];
  buckets: number[][][];
  level: number;
}

/**
 * Water lines drawn once from the shared shore-distance field: neighbouring
 * coasts merge into one ripple where they are close. Rings that touch the
 * field's frame bound the open sea, not an island, and are dropped.
 */
export function createSeaRipples(
  data: AtlasData,
  coasts?: Polygon[]
): SeaRipple[] {
  const { canvas, distances, scale } = oceanField(data, 1280, coasts);
  const { width, height } = canvas;
  const interior = (ring: number[][]) =>
    ring.every(
      ([x = 0, y = 0]) => x > 1 && y > 1 && x < width - 1 && y < height - 1
    );
  const ripples: SeaRipple[] = [];
  for (const [level, offset] of rippleOffsets.entries()) {
    const [band] = contours()
      .size([width, height])
      .thresholds([offset * scale])(Array.from(distances));
    for (const [index, ring] of (band?.coordinates.flat() ?? []).entries()) {
      if (!interior(ring)) {
        continue;
      }
      const points = ring.map(
        ([x = 0, y = 0]) =>
          [
            (x * data.width) / width - data.width / 2,
            (y * data.height) / height - data.height / 2,
          ] as const
      );
      const buckets: number[][][] = penWeights.map(() => []);
      penRuns(points, `ripple:${level}:${index}`, buckets, rippleLift);
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      ripples.push({
        box: [
          Math.min(...xs),
          Math.min(...ys),
          Math.max(...xs),
          Math.max(...ys),
        ],
        buckets,
        level,
      });
    }
  }
  return ripples;
}

/** Barely-there gilt water lines; they surface only as the camera comes in. */
export function paintSeaRipples(
  ctx: CanvasRenderingContext2D,
  ripples: readonly SeaRipple[],
  view: InkView
) {
  const pixels = view.pixelsPerUnit;
  const reveal = Math.max(0, Math.min(1, (pixels - 0.9) / 1.4));
  if (!(reveal && ripples.length)) {
    return;
  }
  const left = view.x - view.width / 2;
  const top = view.y - view.height / 2;
  ctx.save();
  ctx.strokeStyle = "#a8873c";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const ripple of ripples) {
    const [x0, y0, x1, y1] = ripple.box;
    if (
      x1 < left ||
      y1 < top ||
      x0 > left + view.width ||
      y0 > top + view.height
    ) {
      continue;
    }
    ctx.globalAlpha = reveal * (rippleOpacity[ripple.level] ?? 0);
    strokeRuns(ctx, ripple.buckets, 0.7 / pixels);
  }
  ctx.restore();
}
