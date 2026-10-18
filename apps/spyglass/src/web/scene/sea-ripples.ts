import { inkAlpha, inks } from "../ladder/ink-ladder";
import type { SeaRipple } from "../layout/sea-ripples";
import type { InkView } from "../view/chart-view";
import { strokeRuns } from "./paint-paper";

const rippleOpacity = inkAlpha.ripple;

/** Barely-there gilt water lines; they surface only as the camera comes in. */
export function paintSeaRipples(
  ctx: CanvasRenderingContext2D,
  ripples: readonly SeaRipple[],
  view: InkView
) {
  const pixels = view.pixelsPerUnit;
  const reveal = inkAlpha.rippleReveal(pixels);
  if (!(reveal && ripples.length)) {
    return;
  }
  const left = view.x - view.width / 2;
  const top = view.y - view.height / 2;
  ctx.save();
  ctx.strokeStyle = inks.ripple;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const ripple of ripples) {
    const [x0, y0, x1, y1] = ripple.box;
    if (
      x1 < left ||
      y1 < top ||
      x0 > left + view.width ||
      y0 > top + view.height
    ) {
      continue;
    }
    ctx.globalAlpha = reveal * (rippleOpacity[ripple.level] ?? 0);
    strokeRuns(ctx, ripple.buckets, 0.7 / pixels);
  }
  ctx.restore();
}
