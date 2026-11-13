import type { VariationAxis } from "~/typeface/face";

/** The fewest different weights a coordinated run takes. */
export const FEWEST_WEIGHTS = 2;

/**
 * The weights a run would really use: inside the axis, without repeats,
 * lightest first. Two entries on one weight count once.
 */
export const distinctWeights = (
  axis: VariationAxis,
  weights: readonly number[]
): number[] =>
  [
    ...new Set(
      weights
        .filter(Number.isFinite)
        .map((weight) => Math.min(axis.max, Math.max(axis.min, weight)))
    ),
  ].sort((a, b) => a - b);
