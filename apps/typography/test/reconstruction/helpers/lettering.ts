import type { Bitmap, RasterImage } from "~/generation/raster/bitmap";
import { flattenOutline } from "~/generation/raster/flatten";
import { rasterizePolygons } from "~/generation/raster/rasterize";
import type { Evidence } from "~/reconstruction/evidence/evidence";
import type { AxisLocation } from "~/typeface/face";
import { type Outline, type Point, transformOutline } from "~/typeface/outline";
import type { OpenFace } from "~/typeface/reading";

export interface SetLine {
  /** Pixels per em. */
  readonly emSize: number;
  readonly face: OpenFace;
  readonly location?: AxisLocation;
  readonly text: string;
}

export interface SetLettering {
  /** The y of each line's baseline, in pixels from the top. */
  readonly baselines: readonly number[];
  readonly height: number;
  /** Coverage, 0 to 255: the lettering as a perfect camera would see it. */
  readonly ink: Bitmap;
  /** The same lettering as polygons in pixels, for a test that wants to see it from an angle. */
  readonly polygons: readonly Point[][];
  readonly width: number;
}

const MARGIN = 40;
const LEADING = 1.5;

/** Sets lines of text with a face's own shaping, one under the other. */
export const setLettering = (lines: readonly SetLine[]): SetLettering => {
  const polygons: Point[][] = [];
  const baselines: number[] = [];
  let width = 0;
  let y = MARGIN;
  for (const { emSize, face, location, text } of lines) {
    const scale = emSize / face.description.metrics.unitsPerEm;
    y += emSize;
    baselines.push(y);
    let pen = MARGIN / scale;
    for (const shaped of face.shape(text, { location }).glyphs) {
      const { outline } = face.glyph(shaped.glyphId, location);
      const placed: Outline = transformOutline(outline, {
        dx: (pen + shaped.xOffset) * scale,
        dy: y - shaped.yOffset * scale,
        xx: scale,
        xy: 0,
        yx: 0,
        yy: -scale,
      });
      polygons.push(...flattenOutline(placed, 0.05));
      pen += shaped.xAdvance;
    }
    width = Math.max(width, Math.ceil(pen * scale) + MARGIN);
    y += emSize * (LEADING - 1);
  }
  const height = Math.ceil(y) + MARGIN;
  return {
    baselines,
    height,
    ink: rasterizePolygons(polygons, width, height, { antialias: true }),
    polygons,
    width,
  };
};

export type Colour = readonly [number, number, number];

export interface Degradation {
  /** The standard deviation of a Gaussian blur, in pixels. */
  readonly blur: number;
  readonly ground: Colour;
  readonly ink: Colour;
  /** The standard deviation of the noise added to each channel, in levels of 255. */
  readonly noise: number;
  /** The noise is the same for the same seed, so a threshold means the same thing every run. */
  readonly seed: number;
}

/**
 * A small seeded generator (a linear congruential one, with the constants
 * from Numerical Recipes), so the noise can be repeated.
 */
const seeded = (seed: number) => {
  let state = seed;
  return () => {
    state = (1_664_525 * state + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
};

const gaussianBlur = (
  values: Float32Array,
  width: number,
  height: number,
  sigma: number
): Float32Array => {
  if (sigma <= 0) {
    return values;
  }
  const radius = Math.ceil(3 * sigma);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, index) =>
    Math.exp(-((index - radius) ** 2) / (2 * sigma * sigma))
  );
  const total = kernel.reduce((sum, weight) => sum + weight, 0);
  const pass = (source: Float32Array, dx: number, dy: number) => {
    const result = new Float32Array(source.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        for (const [index, weight] of kernel.entries()) {
          const sx = Math.min(
            width - 1,
            Math.max(0, x + (index - radius) * dx)
          );
          const sy = Math.min(
            height - 1,
            Math.max(0, y + (index - radius) * dy)
          );
          sum += weight * (source[sy * width + sx] ?? 0);
        }
        result[y * width + x] = sum / total;
      }
    }
    return result;
  };
  return pass(pass(values, 1, 0), 0, 1);
};

/** A picture of the lettering as a poor camera would take it: soft, grainy, in colour. */
export const degrade = (
  lettering: Bitmap,
  { blur, ground, ink, noise, seed }: Degradation
): RasterImage => {
  const { height, width } = lettering;
  const coverage = gaussianBlur(
    Float32Array.from(lettering.data, (value) => value / 255),
    width,
    height,
    blur
  );
  const random = seeded(seed);
  const grain = () =>
    noise *
    Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) *
    Math.cos(2 * Math.PI * random());
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const share = coverage[pixel] ?? 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const from = ground[channel] ?? 0;
      const to = ink[channel] ?? 0;
      data[pixel * 4 + channel] = Math.min(
        255,
        Math.max(0, Math.round(from + (to - from) * share + grain()))
      );
    }
    data[pixel * 4 + 3] = 255;
  }
  return { data, height, width };
};

const PLAIN: Degradation = {
  blur: 0,
  ground: [255, 255, 255],
  ink: [0, 0, 0],
  noise: 0,
  seed: 1,
};

/** Black lettering on white, exactly as drawn. */
export const plainPicture = (lettering: Bitmap): RasterImage =>
  degrade(lettering, PLAIN);

/** A picture made in a test, wrapped as evidence. It is synthetic and its id says so. */
export const syntheticEvidence = (
  pixels: RasterImage,
  name: string
): Evidence => ({
  file: { bytes: new Uint8Array(), mediaType: "image/png" },
  fileName: `${name}.png`,
  height: pixels.height,
  id: `synthetic-${name}`,
  pixels,
  width: pixels.width,
});
