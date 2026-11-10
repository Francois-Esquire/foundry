/**
 * Separation: which pixels of a region are lettering and which are
 * background. Every pixel is reduced to one number, by tone or by colour, and
 * the numbers are split in two where the split explains most of their spread.
 */
import type { Bitmap, RasterImage } from "~/generation/raster/bitmap";

/** Tone compares lightness alone. Colour compares the two commonest colours. */
type SeparationMethod = "colour" | "tone";

/** Whether the lettering is the darker or the lighter of the two classes. */
type LetteringPolarity = "darker" | "lighter";

export interface SeparationOptions {
  /** Colour when absent. */
  readonly by?: SeparationMethod;
  /** Chosen from the picture when absent: the class along the border is the background. */
  readonly lettering?: LetteringPolarity;
}

export interface Separation {
  readonly by: SeparationMethod;
  /**
   * The lettering as an ink map: 255 for certain lettering, 0 for certain
   * background, and 128 exactly on the boundary between them.
   */
  readonly ink: Bitmap;
  readonly lettering: LetteringPolarity;
  /** Whether the polarity was read from the picture or given by a person. */
  readonly polarity: "automatic" | "given";
  /**
   * How much of the spread of the pixels the split explains, 0 to 1. Clean
   * lettering on a plain ground is above 0.9. A low value means the two
   * classes are not really two.
   */
  readonly separability: number;
}

type Colour = readonly [number, number, number];

const BINS = 256;
const SAMPLE_LIMIT = 40_000;
const CLUSTER_ROUNDS = 8;
/** The share of border pixels a class needs before the border alone names the background. */
const BORDER_MAJORITY = 0.6;

const luminance = ([r, g, b]: Colour) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const colourAt = (image: RasterImage, pixel: number): Colour => [
  image.data[pixel * 4] ?? 0,
  image.data[pixel * 4 + 1] ?? 0,
  image.data[pixel * 4 + 2] ?? 0,
];

const borderPixels = ({ height, width }: RasterImage): number[] => {
  const pixels: number[] = [];
  for (let x = 0; x < width; x += 1) {
    pixels.push(x, (height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    pixels.push(y * width, y * width + width - 1);
  }
  return pixels;
};

const middle = (values: number[]): number =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const apart = (a: Colour, b: Colour) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const meanColour = (colours: readonly Colour[], fallback: Colour): Colour => {
  if (colours.length === 0) {
    return fallback;
  }
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const colour of colours) {
    red += colour[0];
    green += colour[1];
    blue += colour[2];
  }
  return [red / colours.length, green / colours.length, blue / colours.length];
};

/**
 * The two colours the region is made of: the colour of its border, the
 * colour furthest from that, and then both moved to the middle of the pixels
 * nearest each.
 */
const twoColours = (image: RasterImage): readonly [Colour, Colour] => {
  const border = borderPixels(image).map((pixel) => colourAt(image, pixel));
  let first: Colour = [
    middle(border.map((colour) => colour[0])),
    middle(border.map((colour) => colour[1])),
    middle(border.map((colour) => colour[2])),
  ];
  const count = image.width * image.height;
  const step = Math.max(1, Math.floor(count / SAMPLE_LIMIT));
  const sample: Colour[] = [];
  for (let pixel = 0; pixel < count; pixel += step) {
    sample.push(colourAt(image, pixel));
  }
  const origin = first;
  const byDistance = sample.toSorted(
    (a, b) => apart(a, origin) - apart(b, origin)
  );
  let second = byDistance[Math.floor(byDistance.length * 0.98)] ?? first;
  for (let round = 0; round < CLUSTER_ROUNDS; round += 1) {
    const nearFirst: Colour[] = [];
    const nearSecond: Colour[] = [];
    for (const colour of sample) {
      (apart(colour, first) <= apart(colour, second)
        ? nearFirst
        : nearSecond
      ).push(colour);
    }
    first = meanColour(nearFirst, first);
    second = meanColour(nearSecond, second);
  }
  return [first, second];
};

/** One number per pixel: its lightness, or how far it lies from one colour towards the other. */
const fieldOf = (image: RasterImage, by: SeparationMethod): Float32Array => {
  const field = new Float32Array(image.width * image.height);
  if (by === "tone") {
    for (let pixel = 0; pixel < field.length; pixel += 1) {
      field[pixel] = luminance(colourAt(image, pixel)) / 255;
    }
    return field;
  }
  const [from, to] = twoColours(image);
  const axis = [to[0] - from[0], to[1] - from[1], to[2] - from[2]] as const;
  const length = axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2 || 1;
  for (let pixel = 0; pixel < field.length; pixel += 1) {
    const colour = colourAt(image, pixel);
    field[pixel] =
      ((colour[0] - from[0]) * axis[0] +
        (colour[1] - from[1]) * axis[1] +
        (colour[2] - from[2]) * axis[2]) /
      length;
  }
  return field;
};

/** A light blur, one pixel wide, that takes the grain out before the split. */
const smooth = (
  field: Float32Array,
  width: number,
  height: number
): Float32Array => {
  const pass = (source: Float32Array, dx: number, dy: number) => {
    const result = new Float32Array(source.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const before =
          source[Math.max(0, y - dy) * width + Math.max(0, x - dx)] ?? 0;
        const after =
          source[
            Math.min(height - 1, y + dy) * width + Math.min(width - 1, x + dx)
          ] ?? 0;
        result[y * width + x] =
          (before + 2 * (source[y * width + x] ?? 0) + after) / 4;
      }
    }
    return result;
  };
  return pass(pass(field, 1, 0), 0, 1);
};

interface Split {
  readonly high: number;
  readonly low: number;
  readonly separability: number;
  readonly threshold: number;
}

/** Otsu's split: the threshold that leaves the least spread inside each class. */
const splitOf = (field: Float32Array): Split => {
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const value of field) {
    lowest = Math.min(lowest, value);
    highest = Math.max(highest, value);
  }
  const span = highest - lowest || 1;
  const histogram = new Float64Array(BINS);
  for (const value of field) {
    const bin = Math.min(
      BINS - 1,
      Math.floor(((value - lowest) / span) * BINS)
    );
    histogram[bin] = (histogram[bin] ?? 0) + 1;
  }
  const centre = (bin: number) => lowest + ((bin + 0.5) / BINS) * span;
  let total = 0;
  let totalSquares = 0;
  for (let bin = 0; bin < BINS; bin += 1) {
    total += (histogram[bin] ?? 0) * centre(bin);
    totalSquares += (histogram[bin] ?? 0) * centre(bin) ** 2;
  }
  const count = field.length || 1;
  const variance = totalSquares / count - (total / count) ** 2;
  let best: Split = {
    high: highest,
    low: lowest,
    separability: 0,
    threshold: (lowest + highest) / 2,
  };
  let below = 0;
  let belowSum = 0;
  for (let bin = 0; bin < BINS - 1; bin += 1) {
    below += histogram[bin] ?? 0;
    belowSum += (histogram[bin] ?? 0) * centre(bin);
    const above = count - below;
    if (below === 0 || above === 0) {
      continue;
    }
    const low = belowSum / below;
    const high = (total - belowSum) / above;
    const between = (below / count) * (above / count) * (high - low) ** 2;
    const separability = variance > 0 ? between / variance : 0;
    if (separability > best.separability) {
      best = {
        high,
        low,
        separability,
        threshold: lowest + ((bin + 1) / BINS) * span,
      };
    }
  }
  return best;
};

interface Classes {
  /** True when the class above the threshold holds the border, or most of the region. */
  readonly highIsGround: boolean;
  /** True when the class above the threshold is the lighter one. */
  readonly highIsLighter: boolean;
}

const classesOf = (
  image: RasterImage,
  field: Float32Array,
  threshold: number
): Classes => {
  let lowLight = 0;
  let highLight = 0;
  let lowSize = 0;
  let highSize = 0;
  for (let pixel = 0; pixel < field.length; pixel += 1) {
    const light = luminance(colourAt(image, pixel));
    if ((field[pixel] ?? 0) >= threshold) {
      highLight += light;
      highSize += 1;
    } else {
      lowLight += light;
      lowSize += 1;
    }
  }
  const border = borderPixels(image);
  const highOnBorder =
    border.filter((pixel) => (field[pixel] ?? 0) >= threshold).length /
    Math.max(1, border.length);
  let highIsGround = highSize >= lowSize;
  if (highOnBorder >= BORDER_MAJORITY) {
    highIsGround = true;
  } else if (highOnBorder <= 1 - BORDER_MAJORITY) {
    highIsGround = false;
  }
  return {
    highIsGround,
    highIsLighter:
      highLight / Math.max(1, highSize) >= lowLight / Math.max(1, lowSize),
  };
};

/** Separates the lettering of a region from its background. */
export const separateLettering = (
  image: RasterImage,
  options: SeparationOptions = {}
): Separation => {
  const by = options.by ?? "colour";
  const field = smooth(fieldOf(image, by), image.width, image.height);
  const split = splitOf(field);
  const classes = classesOf(image, field, split.threshold);
  const automatic: LetteringPolarity =
    classes.highIsGround === classes.highIsLighter ? "darker" : "lighter";
  const lettering = options.lettering ?? automatic;
  const inkIsHigh = (lettering === "lighter") === classes.highIsLighter;
  const inkMean = inkIsHigh ? split.high : split.low;
  const groundMean = inkIsHigh ? split.low : split.high;
  const data = new Uint8Array(field.length);
  for (let pixel = 0; pixel < field.length; pixel += 1) {
    const value = field[pixel] ?? 0;
    const towardsInk =
      (value - split.threshold) / (inkMean - split.threshold || 1);
    const towardsGround =
      (value - split.threshold) / (groundMean - split.threshold || 1);
    data[pixel] =
      towardsInk >= 0
        ? Math.round(128 + 127 * Math.min(1, towardsInk))
        : Math.round(128 - 128 * Math.min(1, towardsGround));
  }
  return {
    by,
    ink: { data, height: image.height, width: image.width },
    lettering,
    polarity: options.lettering ? "given" : "automatic",
    separability: split.separability,
  };
};
