import type { Polygon, SpyglassData } from "../data/types";
import { channels, grounds } from "../ladder/ink-ladder";
import { oceanField } from "../layout/ocean-field";

/** Offshore distances (map units) where the sea steps one shade deeper. */
export const depthSteps = [6, 14, 26, 42, 64, 92];
/** Distances beyond the archipelago rim where open water steps toward ocean blue. */
export const openSeaSteps = [14, 80, 170, 280, 410, 560];
const shoreWater = channels(grounds.shoreWater);
const deepWater = channels(grounds.deepWater);
const oceanBlue = channels(grounds.openWater);

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

/**
 * Layered sea: each step offshore is a slightly deeper, slightly cooler wash.
 * Steps follow offsets of every coast, so neighbouring islands share their
 * lobes. Beyond each archipelago's rim the same layering continues, slightly
 * darker, out to an ocean blue at the chart's edge: a natural vignette.
 */
export function oceanShade(
  distance: number,
  outsideRim = 0
): [number, number, number] {
  const depth = layered(distance, depthSteps, 2);
  const open = layered(outsideRim, openSeaSteps, 10);
  return [0, 1, 2].map((channel) => {
    const near = shoreWater[channel] ?? 0;
    const deep = deepWater[channel] ?? 0;
    const water = near + (deep - near) * depth;
    return Math.round(water + ((oceanBlue[channel] ?? 0) - water) * open);
  }) as [number, number, number];
}

/** Shades the layout's ocean field cell by cell and lays it over the chart. */
export function paintOcean(
  ctx: CanvasRenderingContext2D,
  data: SpyglassData,
  coasts?: Polygon[]
): void {
  const { width, height, distances, outside, scale } = oceanField(
    data,
    1280,
    coasts
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const sea = canvas.getContext("2d");
  if (!sea) {
    throw new Error("Canvas rendering is unavailable.");
  }
  const pixels = sea.createImageData(width, height);
  for (const [i, distance] of distances.entries()) {
    pixels.data.set(
      oceanShade(distance / scale, (outside[i] ?? 0) / scale),
      i * 4
    );
    pixels.data[i * 4 + 3] = 255;
  }
  sea.putImageData(pixels, 0, 0);
  ctx.drawImage(
    canvas,
    -data.width / 2,
    -data.height / 2,
    data.width,
    data.height
  );
}
