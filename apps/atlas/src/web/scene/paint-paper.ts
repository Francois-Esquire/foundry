import { chartGrid } from "../codex/bindings";
import type { AtlasData, Territory } from "../types";
import type { InkView } from "./exploration";

/** Coordinates stay fixed while minor divisions become legible with zoom. */
export function paintChartGrid(
  ctx: CanvasRenderingContext2D,
  view: InkView,
  data: AtlasData
) {
  const { pixelsPerUnit: pixels } = view;
  const { majorStep, minorOpacity, minorStep } = chartGrid(pixels);
  const left = view.x - view.width / 2;
  const top = view.y - view.height / 2;
  const right = left + view.width;
  const bottom = top + view.height;
  ctx.save();
  // Sea ink stops at land; the same coordinates are printed on the relief mesh.
  ctx.beginPath();
  ctx.rect(left, top, view.width, view.height);
  traceLand(ctx, data);
  ctx.clip("evenodd");
  for (const { step, opacity, width } of [
    { opacity: minorOpacity, step: minorStep, width: 0.5 },
    { opacity: 0.3, step: majorStep, width: 0.7 },
  ]) {
    if (!opacity) {
      continue;
    }
    ctx.beginPath();
    ctx.strokeStyle = `rgba(105, 111, 91, ${opacity})`;
    ctx.lineWidth = width / pixels;
    for (let x = Math.ceil(left / step) * step; x <= right; x += step) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (let y = Math.ceil(top / step) * step; y <= bottom; y += step) {
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Fine coast ink is repainted at viewport resolution, never magnified texels. */
export function paintCoastInk(
  ctx: CanvasRenderingContext2D,
  territory: Territory,
  pixels: number,
  selected: boolean
) {
  ctx.save();
  ctx.translate(territory.x, territory.y);
  ctx.beginPath();
  for (const polygon of territory.coast) {
    for (const ring of polygon) {
      for (const [index, [x, y]] of ring.entries()) {
        if (index) {
          ctx.lineTo(x, y);
        } else {
          ctx.moveTo(x, y);
        }
      }
      ctx.closePath();
    }
  }
  ctx.lineJoin = "round";
  // The pale inner edge and fine cut line survive changes in screen-space AO.
  ctx.save();
  ctx.clip("evenodd");
  ctx.strokeStyle = "#fff4d5c0";
  ctx.lineWidth = 3 / pixels;
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = selected ? "#875222cc" : "#62533db0";
  ctx.lineWidth = (selected ? 1.25 : 0.9) / pixels;
  ctx.stroke();
  ctx.restore();
}

function traceLand(ctx: CanvasRenderingContext2D, data: AtlasData) {
  for (const territory of data.territories) {
    for (const polygon of territory.coast) {
      for (const ring of polygon) {
        for (const [index, [x, y]] of ring.entries()) {
          if (index) {
            ctx.lineTo(x + territory.x, y + territory.y);
          } else {
            ctx.moveTo(x + territory.x, y + territory.y);
          }
        }
        ctx.closePath();
      }
    }
  }
}
