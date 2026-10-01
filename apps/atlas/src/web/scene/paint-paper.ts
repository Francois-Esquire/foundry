import type { AtlasData, Territory } from "../types";
import type { InkView } from "./exploration";

/** The folds belong to the sheet, not to any package or measured value. */
export function paintPaperFolds(
  ctx: CanvasRenderingContext2D,
  data: AtlasData,
  view: InkView
) {
  const { pixelsPerUnit: pixels } = view;
  const left = view.x - view.width / 2;
  const top = view.y - view.height / 2;
  const breadth = Math.min(9, 28 / pixels);
  ctx.save();
  for (const [vertical, position] of [
    [true, -data.width / 6],
    [true, data.width / 6],
    [false, -data.height / 8],
    [false, data.height / 4],
  ] as const) {
    const gradient = vertical
      ? ctx.createLinearGradient(position - breadth, 0, position + breadth, 0)
      : ctx.createLinearGradient(0, position - breadth, 0, position + breadth);
    gradient.addColorStop(0, "#695d4700");
    gradient.addColorStop(0.4, "#695d470c");
    gradient.addColorStop(0.49, "#695d4724");
    gradient.addColorStop(0.51, "#fff9e52b");
    gradient.addColorStop(0.68, "#fff9e514");
    gradient.addColorStop(1, "#fff9e500");
    ctx.fillStyle = gradient;
    if (vertical) {
      ctx.fillRect(position - breadth, top, breadth * 2, view.height);
    } else {
      ctx.fillRect(left, position - breadth, view.width, breadth * 2);
    }
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
  ctx.strokeStyle = selected ? "#875222b0" : "#655f4d90";
  ctx.lineWidth = (selected ? 1.15 : 0.7) / pixels;
  ctx.stroke();
  ctx.restore();
}
