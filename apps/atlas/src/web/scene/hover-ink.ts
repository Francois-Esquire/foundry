import type { Territory } from "../types";

/** Amber, the ink of focus; a soft band beneath a fine line. */
const hoverInk = "190, 132, 48";
const hoverStrokes = [
  { alpha: 0.14, pixels: 6 },
  { alpha: 0.7, pixels: 1.6 },
] as const;

/**
 * Inks the coast of the island under the pointer, at a constant screen width,
 * on a context already in map coordinates (as `paintMap` leaves the ink
 * canvas). Static: it appears and goes with the hover, nothing fades.
 */
export function paintHoverInk(
  ctx: CanvasRenderingContext2D,
  territory: Territory | null,
  pixelsPerUnit: number
): void {
  if (!territory) {
    return;
  }
  ctx.save();
  ctx.beginPath();
  for (const polygon of territory.coast) {
    for (const ring of polygon) {
      ring.forEach(([x, y], i) => {
        if (i) {
          ctx.lineTo(territory.x + x, territory.y + y);
        } else {
          ctx.moveTo(territory.x + x, territory.y + y);
        }
      });
      ctx.closePath();
    }
  }
  ctx.setLineDash([]);
  ctx.lineJoin = "round";
  for (const { alpha, pixels } of hoverStrokes) {
    ctx.strokeStyle = `rgba(${hoverInk}, ${alpha})`;
    ctx.lineWidth = pixels / pixelsPerUnit;
    ctx.stroke();
  }
  ctx.restore();
}
