import { compositionFrame, compositionReveal } from "./composition-motion";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import type { Territory } from "./types";

export function paintComposition(
  ctx: CanvasRenderingContext2D,
  territory: Territory,
  overlay: ResponsibilityOverlay,
  pixels: number
) {
  const composition = overlay.composition;
  const file = territory.files.find((item) => item.id === composition?.fileId);
  if (!(composition && file)) {
    return;
  }
  const { detail } = compositionReveal(pixels);
  if (!detail) {
    return;
  }
  ctx.save();
  ctx.beginPath();
  for (const polygon of territory.coast) {
    for (const ring of polygon) {
      ring.forEach(([x, y], index) => {
        if (index) {
          ctx.lineTo(x, y);
        } else {
          ctx.moveTo(x, y);
        }
      });
      ctx.closePath();
    }
  }
  ctx.clip("evenodd");
  ctx.globalAlpha = detail;
  ctx.translate(file.x, file.y);
  const active = new Set(composition.active);
  const blockers = new Set(overlay.trace?.blockers ?? []);
  ctx.lineWidth = 1 / pixels;
  for (const mark of compositionFrame(overlay, pixels)) {
    const { x, y } = mark;
    ctx.fillStyle = "#f1ead9";
    ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
    ctx.strokeStyle = blockers.has(mark.id)
      ? "#963f32"
      : active.has(mark.id)
        ? "#875222"
        : "#4a4233";
    ctx.strokeRect(x - 0.5, y - 0.5, 1, 1);
    if (blockers.has(mark.id)) {
      ctx.beginPath();
      ctx.moveTo(x - 0.5, y - 0.5);
      ctx.lineTo(x + 0.5, y + 0.5);
      ctx.stroke();
    }
    if (mark.ghost) {
      const { x: tx, y: ty, alpha, tether } = mark.ghost;
      ctx.globalAlpha = detail * alpha;
      ctx.strokeStyle = "#875222";
      ctx.setLineDash([2 / pixels, 2 / pixels]);
      if (tether) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }
      ctx.fillStyle = "#f1ead9b8";
      ctx.fillRect(tx - 0.6, ty - 0.6, 1.2, 1.2);
      ctx.strokeRect(tx - 0.6, ty - 0.6, 1.2, 1.2);
      ctx.setLineDash([]);
      ctx.globalAlpha = detail;
    }
  }
  ctx.restore();
}
