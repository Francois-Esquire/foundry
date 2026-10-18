import { inks } from "../../ladder/ink-ladder";
import { compassCentre } from "../../layout/compass";
import type { InkState } from "./state";

/**
 * The compass rose at the chart's north-east corner; it opens chart
 * settings. Its "N" is lettered by the labels layer (`scene/labels/`); the
 * rose itself is painted until 4f.
 */
export function paintChartCompass(state: InkState): void {
  const { x, y } = compassCentre(state.data);
  paintCompass(state.ctx, x, y);
}

function paintCompass(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = inks.compass;
  ctx.fillStyle = inks.compass;
  ctx.lineWidth = 0.65;
  ctx.beginPath();
  ctx.arc(0, 0, 23, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 8; i += 1) {
    ctx.save();
    ctx.rotate((i * Math.PI) / 4);
    ctx.beginPath();
    ctx.moveTo(0, -35);
    ctx.lineTo(4, 0);
    ctx.lineTo(0, 8);
    ctx.lineTo(-4, 0);
    ctx.closePath();
    if (i % 2 === 0) {
      ctx.fill();
    } else {
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}
