import type { Polygon } from "../../data/types";

/** One path through every ring of the polygons, ready to fill, stroke or clip. */
export function trace(
  ctx: CanvasRenderingContext2D,
  polygons: Polygon[]
): void {
  ctx.beginPath();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      ring.forEach(([x, y], i) => {
        if (i) {
          ctx.lineTo(x, y);
        } else {
          ctx.moveTo(x, y);
        }
      });
      ctx.closePath();
    }
  }
}
