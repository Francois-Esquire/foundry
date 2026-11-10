/**
 * Turns a decoded picture into an ink map, whatever its colours: the paper
 * is whatever the border of the picture is, and ink is whatever differs most.
 */
import type { Bitmap, RasterImage } from "../raster/bitmap";

const DARKEST_SHARE = 0.01;
/** Below this spread between paper and ink the picture is blank. */
const MINIMUM_SPREAD = 24;

/** Luminance of each pixel, 0 to 255, with transparency read as white paper. */
const luminanceOf = (image: RasterImage): Uint8Array => {
  const luminance = new Uint8Array(image.width * image.height);
  for (let index = 0; index < luminance.length; index += 1) {
    const at = index * 4;
    const alpha = (image.data[at + 3] ?? 255) / 255;
    const colour =
      0.2126 * (image.data[at] ?? 0) +
      0.7152 * (image.data[at + 1] ?? 0) +
      0.0722 * (image.data[at + 2] ?? 0);
    luminance[index] = Math.round(colour * alpha + 255 * (1 - alpha));
  }
  return luminance;
};

const medianOf = (values: number[]): number => {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 255;
};

const borderLuminance = (
  luminance: Uint8Array,
  width: number,
  height: number
): number => {
  const border: number[] = [];
  for (let x = 0; x < width; x += 1) {
    border.push(luminance[x] ?? 0, luminance[(height - 1) * width + x] ?? 0);
  }
  for (let y = 0; y < height; y += 1) {
    border.push(
      luminance[y * width] ?? 0,
      luminance[y * width + width - 1] ?? 0
    );
  }
  return medianOf(border);
};

/** The level a small share of the pixels differ from paper by at least. */
const inkSpread = (difference: Uint8Array): number => {
  const histogram = new Uint32Array(256);
  for (const value of difference) {
    histogram[value] = (histogram[value] ?? 0) + 1;
  }
  let remaining = Math.max(1, Math.floor(difference.length * DARKEST_SHARE));
  for (let level = 255; level > 0; level -= 1) {
    remaining -= histogram[level] ?? 0;
    if (remaining <= 0) {
      return level;
    }
  }
  return 0;
};

/**
 * The ink map of a picture: 255 where it differs most from the paper, 0 on
 * the paper. Works for dark ink on light paper and for the reverse.
 */
export const inkFromImage = (image: RasterImage): Bitmap => {
  const luminance = luminanceOf(image);
  const paper = borderLuminance(luminance, image.width, image.height);
  const difference = luminance.map((value) => Math.abs(value - paper));
  const spread = inkSpread(difference);
  const data =
    spread < MINIMUM_SPREAD
      ? new Uint8Array(difference.length)
      : difference.map((value) =>
          Math.min(255, Math.round((255 * value) / spread))
        );
  return { data, height: image.height, width: image.width };
};
