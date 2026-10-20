import { contours } from "d3-contour";
import type { SpyglassData } from "../data/types";
import type { OceanField } from "./ocean-field";
import { penRuns, penWeights } from "./pen-runs";

/** Offshore distances of the gilded ripples, in map units. */
const rippleOffsets = [2.4, 4.8, 7.6];
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
  data: SpyglassData,
  shore: OceanField
): SeaRipple[] {
  const { width, height, distances, scale } = shore;
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
