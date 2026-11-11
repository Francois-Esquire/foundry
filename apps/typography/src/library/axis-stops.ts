/** What an axis slider needs from a variable face: its step and its named stops. */
import type {
  AxisLocation,
  NamedInstance,
  VariationAxis,
} from "~/typeface/face";

export interface AxisStop {
  readonly name: string;
  readonly value: number;
}

const WIDE_RANGE = 50;
const MEDIUM_RANGE = 5;

/** One unit on a wide axis such as weight, finer on a narrow one such as slant. */
export const axisStep = (axis: VariationAxis) => {
  const range = axis.max - axis.min;
  if (range >= WIDE_RANGE) {
    return 1;
  }
  return range >= MEDIUM_RANGE ? 0.5 : 0.01;
};

const restsElsewhere = (
  instance: NamedInstance,
  axis: VariationAxis,
  axes: readonly VariationAxis[]
) =>
  axes.every(
    (other) =>
      other.tag === axis.tag ||
      (instance.location[other.tag] ?? other.default) === other.default
  );

/**
 * The named instances that are positions on this one axis: every other axis
 * sits at its default, so moving this slider alone reaches the instance. One
 * stop per value, the first name winning.
 */
export const axisStops = (
  axis: VariationAxis,
  axes: readonly VariationAxis[],
  instances: readonly NamedInstance[]
): AxisStop[] => {
  const byValue = new Map<number, string>();
  for (const instance of instances) {
    const value = instance.location[axis.tag] ?? axis.default;
    if (restsElsewhere(instance, axis, axes) && !byValue.has(value)) {
      byValue.set(value, instance.name);
    }
  }
  return [...byValue.entries()]
    .map(([value, name]) => ({ name, value }))
    .sort((a, b) => a.value - b.value);
};

/** A location with one axis moved. */
export const moveAxis = (
  location: AxisLocation,
  tag: string,
  value: number
): AxisLocation => ({ ...location, [tag]: value });
