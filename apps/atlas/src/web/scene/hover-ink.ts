import type { Territory } from "../types";
import { inkAlpha, inkStyle, inks } from "./ink-ladder";

/** A soft band beneath a fine solid line, in the ladder's hover amber. */
const hoverStrokes = [
  { alpha: inkAlpha.hoverBand, pixels: 6 },
  { alpha: inkAlpha.hoverLine, pixels: inkStyle("hover").weight },
] as const;

/**
 * Inks the coast of the island under the pointer, at a constant screen width,
 * on a context already in map coordinates (as `paintInk` sets up the ink
 * canvas for every layer). Static: it appears and goes with the hover, nothing fades.
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
    ctx.strokeStyle = inks.hover;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = pixels / pixelsPerUnit;
    ctx.stroke();
  }
  ctx.restore();
}
