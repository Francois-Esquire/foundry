import { inks } from "../ink-ladder";
import type { InkState } from "./state";

/** The compass rose at the chart's north-east corner; it opens chart settings. */
export function paintChartCompass(state: InkState): void {
  paintCompass(
    state.ctx,
    state.data.width / 2 - 88,
    -state.data.height / 2 + 94
  );
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
  ctx.font = "10px AtlasDisplay";
  ctx.textAlign = "center";
  ctx.fillText("N", 0, -43);
  ctx.restore();
}
