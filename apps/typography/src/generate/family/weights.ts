/**
 * The weights a coordinated run works at: where they start, which named
 * instances can be chosen, and what a list of them comes to once it is
 * tidied the way the family engine tidies it.
 */
import { type Face, isVariable, type VariationAxis } from "~/typeface/face";

const WEIGHT = "wght";

/** The weight axis of a variable face. Undefined for any other face. */
export const weightAxisOf = (face: Face): VariationAxis | undefined =>
  isVariable(face)
    ? face.description.axes.find((axis) => axis.tag === WEIGHT)
    : undefined;

/** True for a face the Generate place can work on across weights. */
export const canCoordinate = (face: Face) => weightAxisOf(face) !== undefined;

/** The axes a coordinated run leaves at their defaults. */
export const otherAxesOf = (face: Face): readonly VariationAxis[] =>
  face.description.axes.filter((axis) => axis.tag !== WEIGHT);

/** The axis minimum, default and maximum, lightest first, without repeats. */
export const startingWeights = (axis: VariationAxis): number[] =>
  [...new Set([axis.min, axis.default, axis.max])].sort((a, b) => a - b);

export interface NamedWeight {
  readonly name: string;
  readonly weight: number;
}

/**
 * The face's named instances along the weight axis, lightest first. An
 * instance that moves another axis as well is left out, since a coordinated
 * run keeps every other axis at its default.
 */
export const namedWeights = (face: Face): NamedWeight[] => {
  const others = otherAxesOf(face);
  const axis = weightAxisOf(face);
  if (!axis) {
    return [];
  }
  return face.description.instances
    .filter((instance) =>
      others.every(
        (other) =>
          (instance.location[other.tag] ?? other.default) === other.default
      )
    )
    .map((instance) => ({
      name: instance.name,
      weight: instance.location[WEIGHT] ?? axis.default,
    }))
    .sort((a, b) => a.weight - b.weight);
};

/** What a weight is called: its named instance, or the axis value. */
export const weightName = (face: Face, weight: number): string =>
  namedWeights(face).find((named) => named.weight === weight)?.name ??
  `${WEIGHT}${weight}`;

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
      weights.map((weight) => Math.min(axis.max, Math.max(axis.min, weight)))
    ),
  ].sort((a, b) => a - b);

/** A weight between the two entries furthest apart, to start a new entry from. */
export const weightToAdd = (
  axis: VariationAxis,
  weights: readonly number[]
): number => {
  const taken = distinctWeights(axis, [...weights, axis.min, axis.max]);
  let best = { from: axis.min, gap: 0 };
  for (const [index, weight] of taken.entries()) {
    const gap = (taken[index + 1] ?? weight) - weight;
    if (gap > best.gap) {
      best = { from: weight, gap };
    }
  }
  return Math.round(best.from + best.gap / 2);
};
