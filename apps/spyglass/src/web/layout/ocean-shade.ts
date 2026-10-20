import type { OceanField } from "./ocean-field";

/** Offshore distances (map units) where the sea steps one shade deeper. */
export const depthSteps = [6, 14, 26, 42, 64, 92];
/** Distances beyond the archipelago rim where open water steps toward ocean blue. */
export const openSeaSteps = [14, 80, 170, 280, 410, 560];
const depthSoftness = 2;
const openSoftness = 10;

/**
 * The shallows: a soft band of lighter water this wide off every coast, in
 * map units, feathered over `softness` on either side of its edge. It reads
 * as the feathered polygons the coast sheet once carried did at island zoom.
 */
export const shallowsBand = { softness: 1, width: 3.2 } as const;

/** Fraction of `steps` passed at `distance`; each step is a soft wash, never a line. */
function layered(distance: number, steps: readonly number[], softness: number) {
  let level = 0;
  for (const step of steps) {
    const t = Math.min(
      1,
      Math.max(0, (distance - step + softness) / (2 * softness))
    );
    level += t * t * (3 - 2 * t);
  }
  return level / steps.length;
}

/** How far the water has stepped from the shore's shade to deep water, 0 to 1, at `distance` map units off the coast. */
export function depthLevel(distance: number): number {
  return layered(distance, depthSteps, depthSoftness);
}

/** How far the water has stepped from deep water to ocean blue, 0 to 1, at `outsideRim` map units beyond the archipelago. */
export function openLevel(outsideRim: number): number {
  return layered(outsideRim, openSeaSteps, openSoftness);
}

/**
 * Layered sea: each step offshore is a slightly deeper, slightly cooler wash.
 * Steps follow offsets of every coast, so neighbouring islands share their
 * lobes. Beyond each archipelago's rim the same layering continues, slightly
 * darker, out to an ocean blue at the chart's edge: a natural vignette. The
 * two levels for every cell of the field, interleaved in its row order; the
 * water material mixes the ladder's three water grounds by them.
 */
export function shadeLevels(field: OceanField): Float32Array {
  const { distances, outside, scale } = field;
  const levels = new Float32Array(distances.length * 2);
  for (const [i, distance] of distances.entries()) {
    levels[i * 2] = depthLevel(distance / scale);
    levels[i * 2 + 1] = openLevel((outside[i] ?? 0) / scale);
  }
  return levels;
}
