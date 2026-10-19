import { shoreDistances } from "./distance-field";
import { fillPolygon } from "./scanline-fill";
import type { IslandGeometry } from "./types";

/** A reusable local coast-distance field lets every shelf follow the same real shoreline. */
export function coastField(island: IslandGeometry, margin = 100) {
  const points = island.coast.flatMap((polygon) => polygon[0] ?? []);
  if (!points.length) {
    return;
  }
  const left = Math.min(...points.map(([x]) => x)) - margin;
  const top = Math.min(...points.map(([, y]) => y)) - margin;
  const spanX = Math.max(...points.map(([x]) => x)) + margin - left;
  const spanY = Math.max(...points.map(([, y]) => y)) + margin - top;
  const scale = 192 / Math.max(spanX, spanY);
  const width = Math.ceil(spanX * scale);
  const height = Math.ceil(spanY * scale);
  const mask = new Uint8Array(width * height);
  for (const polygon of island.coast) {
    fillPolygon(
      mask,
      width,
      height,
      polygon.map((ring) =>
        ring.map(([x, y]) => [(x - left) * scale, (y - top) * scale])
      )
    );
  }
  const distances = shoreDistances(mask, width, height);
  return {
    distance(x: number, y: number) {
      const gx = (x - island.x - left) * scale - 0.5;
      const gy = (y - island.y - top) * scale - 0.5;
      if (gx < 0 || gy < 0 || gx >= width - 1 || gy >= height - 1) {
        return Number.POSITIVE_INFINITY;
      }
      const column = Math.floor(gx);
      const row = Math.floor(gy);
      const tx = gx - column;
      const ty = gy - row;
      const index = row * width + column;
      const upper =
        (distances[index] ?? 0) * (1 - tx) + (distances[index + 1] ?? 0) * tx;
      const lower =
        (distances[index + width] ?? 0) * (1 - tx) +
        (distances[index + width + 1] ?? 0) * tx;
      return (upper * (1 - ty) + lower * ty) / scale;
    },
    radius: Math.max(...points.map(([x, y]) => Math.hypot(x, y))),
  };
}
