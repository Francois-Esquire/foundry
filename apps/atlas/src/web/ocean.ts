import { archipelagoHull, traceArchipelago } from "./archipelago";
import { shoreDistances } from "./distance-field";
import type { AtlasData, Polygon } from "./types";

export function oceanShade(
  distance: number,
  outsideRim = 0
): [number, number, number] {
  const t = Math.min(1, Math.max(0, distance / 40));
  const depth = t * t * (3 - 2 * t);
  const outer = Math.min(1, Math.max(0, outsideRim / 1100));
  const vignette = outer * outer * (3 - 2 * outer);
  return [
    Math.round(220 - 7 * depth - 4 * vignette),
    Math.round(224 - 5 * depth - 5 * vignette),
    Math.round(207 - 5 * depth - 5 * vignette),
  ];
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
    640,
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
