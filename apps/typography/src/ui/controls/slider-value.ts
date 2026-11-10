/** The arithmetic of an axis slider, kept apart from the component. */

export interface SliderRange {
  readonly max: number;
  readonly min: number;
  readonly step: number;
}

/** How many steps PageUp, PageDown and Shift with an arrow move. */
const LARGE_STEP = 10;

const clamp = (value: number, { max, min }: SliderRange) =>
  Math.min(max, Math.max(min, value));

const decimalsOf = (value: number) => {
  const [, fraction = ""] = String(value).split(".");
  return fraction.length;
};

/** Removes the binary noise that step arithmetic leaves behind. */
const tidy = (value: number, { min, step }: SliderRange) =>
  Number(value.toFixed(Math.max(decimalsOf(min), decimalsOf(step))));

/** Steps from the minimum, rounded so 0.3 / 0.1 counts as exactly 3. */
const stepsFromMin = (value: number, { min, step }: SliderRange) =>
  Math.round(((value - min) / step) * 1e6) / 1e6;

/** The nearest value the slider can hold. The maximum is always allowed. */
export const snapToStep = (value: number, range: SliderRange) => {
  const inside = clamp(value, range);
  if (inside === range.max) {
    return inside;
  }
  const snapped =
    range.min + Math.round(stepsFromMin(inside, range)) * range.step;
  return clamp(tidy(snapped, range), range);
};

const moveBy = (value: number, steps: number, range: SliderRange) => {
  const position = stepsFromMin(value, range);
  // From between two steps, the first move lands on the neighbouring step.
  const start = steps > 0 ? Math.floor(position) : Math.ceil(position);
  return clamp(tidy(range.min + (start + steps) * range.step, range), range);
};

/**
 * The value after a key press, or undefined when the key is not one the
 * slider answers to.
 */
export const valueAfterKey = (
  value: number,
  key: string,
  range: SliderRange,
  large = false
): number | undefined => {
  const steps = large ? LARGE_STEP : 1;
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return moveBy(value, steps, range);
    case "ArrowLeft":
    case "ArrowDown":
      return moveBy(value, -steps, range);
    case "PageUp":
      return moveBy(value, LARGE_STEP, range);
    case "PageDown":
      return moveBy(value, -LARGE_STEP, range);
    case "Home":
      return range.min;
    case "End":
      return range.max;
    default:
      return;
  }
};

/** Reads a typed number, accepting a decimal comma. */
export const parseReadout = (text: string): number | undefined => {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") {
    return;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Where a value sits along the track, from 0 to 1. */
export const fractionOf = (value: number, range: SliderRange) =>
  range.max === range.min
    ? 0
    : (clamp(value, range) - range.min) / (range.max - range.min);
