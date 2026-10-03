import { shoreDistances } from "../distance-field";
import type { AtlasData, Polygon } from "../types";
import { archipelagoHull, traceArchipelago } from "./archipelago";

/** Offshore distances (map units) where the sea steps one shade deeper. */
export const depthSteps = [6, 14, 26, 42, 64, 92];
/** Distances beyond the archipelago rim where open water steps toward ocean blue. */
export const openSeaSteps = [14, 80, 170, 280, 410, 560];
const shoreWater = [223, 227, 211] as const;
const deepWater = [199, 210, 199] as const;
const oceanBlue = [180, 196, 197] as const;

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
 * lobes. Beyond the archipelago rim the same layering continues, slightly
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

export function oceanField(
  data: AtlasData,
  resolution = 640,
  coasts?: Polygon[]
) {
  const canvas = document.createElement("canvas");
  const scale = resolution / Math.max(data.width, data.height);
  canvas.width = Math.max(1, Math.round(data.width * scale));
  canvas.height = Math.max(1, Math.round(data.height * scale));
  const mask = canvas.getContext("2d");
  if (!mask) {
    throw new Error("Canvas rendering is unavailable.");
  }
  mask.scale(canvas.width / data.width, canvas.height / data.height);
  mask.translate(data.width / 2, data.height / 2);
  const lands = coasts ? [{ coast: coasts, x: 0, y: 0 }] : data.territories;
  for (const p of lands) {
    for (const polygon of p.coast) {
      mask.beginPath();
      for (const ring of polygon) {
        ring.forEach(([x, y], i) => {
          if (i) {
            mask.lineTo(p.x + x, p.y + y);
          } else {
            mask.moveTo(p.x + x, p.y + y);
          }
        });
        mask.closePath();
      }
      mask.fill("evenodd");
    }
  }
  const pixels = mask.getImageData(0, 0, canvas.width, canvas.height);
  const land = Uint8Array.from(
    { length: canvas.width * canvas.height },
    (_, i) => ((pixels.data[i * 4 + 3] ?? 0) > 0 ? 1 : 0)
  );
  const distances = shoreDistances(land, canvas.width, canvas.height);
  const hull = archipelagoHull(data);
  traceArchipelago(mask, hull);
  mask.fill();
  const envelope = mask.getImageData(0, 0, canvas.width, canvas.height);
  const region = Uint8Array.from(land, (_, i) =>
    (envelope.data[i * 4 + 3] ?? 0) > 0 ? 1 : 0
  );
  const outside = shoreDistances(region, canvas.width, canvas.height);
  return { canvas, distances, hull, mask, outside, pixels, scale };
}

export function paintOcean(
  ctx: CanvasRenderingContext2D,
  data: AtlasData,
  coasts?: Polygon[]
): void {
  const { canvas, mask, pixels, distances, outside, scale } = oceanField(
    data,
    1280,
    coasts
  );
  for (const [i, distance] of distances.entries()) {
    pixels.data.set(
      oceanShade(distance / scale, (outside[i] ?? 0) / scale),
      i * 4
    );
    pixels.data[i * 4 + 3] = 255;
  }
  mask.putImageData(pixels, 0, 0);
  ctx.drawImage(
    canvas,
    -data.width / 2,
    -data.height / 2,
    data.width,
    data.height
  );
}
