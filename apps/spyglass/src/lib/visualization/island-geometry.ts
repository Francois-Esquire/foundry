import { contours } from "d3-contour";
import type { Polygon } from "./types";

/**
 * The spread of each file's influence on its island's land: wider for a
 * sparse island, between 4 and 10 units.
 */
export function contourSigma(radius: number, files: number) {
  return Math.max(4, Math.min(10, (radius / Math.sqrt(files)) * 0.65));
}

export function landContours(
  files: readonly { x: number; y: number }[],
  radius: number
): Polygon[][] {
  if (!files.length) {
    return [[], [], []];
  }
  const size = 112;
  const span = radius * 2.5;
  const cell = span / size;
  const sigma = contourSigma(radius, files.length);
  const field = new Array<number>(size * size).fill(0);
  for (const f of files) {
    const cx = (f.x + span / 2) / cell;
    const cy = (f.y + span / 2) / cell;
    const extent = Math.ceil((sigma * 3) / cell);
    for (
      let y = Math.max(0, Math.floor(cy - extent));
      y < Math.min(size, cy + extent);
      y += 1
    ) {
      for (
        let x = Math.max(0, Math.floor(cx - extent));
        x < Math.min(size, cx + extent);
        x += 1
      ) {
        const d2 = ((x - cx) ** 2 + (y - cy) ** 2) * cell ** 2;
        field[y * size + x] =
          (field[y * size + x] ?? 0) + Math.exp(-d2 / (2 * sigma ** 2));
      }
    }
  }
  return contours()
    .size([size, size])
    .thresholds([0.18, 0.5, 1.8])(field)
    .map((c) =>
      c.coordinates.map((polygon) =>
        polygon.map((ring) =>
          ring.map(([x = 0, y = 0]): [number, number] => [
            x * cell - span / 2,
            y * cell - span / 2,
          ])
        )
      )
    );
}
