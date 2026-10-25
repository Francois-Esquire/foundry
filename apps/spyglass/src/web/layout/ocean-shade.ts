import type { OceanField } from "./ocean-field";

/** Distances beyond the terrain's silhouette where open water steps toward ocean blue. */
export const openSeaSteps = [14, 80, 170, 280, 410, 560];
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

/** How far the water has stepped from deep water to ocean blue, 0 to 1, at `outsideRim` map units beyond the silhouette. */
export function openLevel(outsideRim: number): number {
  return layered(outsideRim, openSeaSteps, openSoftness);
}

/**
 * Open sea: within the terrain's silhouette the water's depth is the
 * terrain's own. Beyond it, layering continues, slightly darker, out to an
 * ocean blue at the chart's edge: a natural vignette that follows the
 * formation's outline rather than an enclosing ring. One level for every
 * cell of the field, in its row order.
 */
export function shadeLevels(field: OceanField): Float32Array {
  const { outside, scale } = field;
  return Float32Array.from(outside, (cells) => openLevel(cells / scale));
}
