import type { SpyglassData } from "../../data/types";
import { inks } from "../../ladder/ink-ladder";
import type { InkState } from "./state";

/** The compass rose's centre, in map units: at the chart's north-east corner. */
function compassCentre(data: Pick<SpyglassData, "height" | "width">) {
  return { x: data.width / 2 - 88, y: -data.height / 2 + 94 };
}

/**
 * What the compass rose covers, in map units: its points, 35 units from the
 * centre, and the "N" above them. Names that would sit on it keep clear.
 */
export function compassBox(data: Pick<SpyglassData, "height" | "width">) {
  const { x, y } = compassCentre(data);
  return { east: x + 35, north: y - 53, south: y + 35, west: x - 35 };
}

/** The compass rose at the chart's north-east corner; it opens chart settings. */
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
  ctx.font = "10px SpyglassDisplay";
  ctx.textAlign = "center";
  ctx.fillText("N", 0, -43);
  ctx.restore();
}
