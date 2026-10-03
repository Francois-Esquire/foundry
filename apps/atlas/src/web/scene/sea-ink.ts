import type { AtlasData } from "../types";
import type { InkView } from "./exploration";

/** Keep flat ink only off land; the uncut original is printed on the relief. */
export function copySeaInk(
  canvas: HTMLCanvasElement,
  source: HTMLCanvasElement,
  data: AtlasData,
  view: InkView
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.resetTransform();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);
  ctx.save();
  ctx.scale(canvas.width / view.width, canvas.height / view.height);
  ctx.translate(view.width / 2 - view.x, view.height / 2 - view.y);
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  for (const territory of data.territories) {
    for (const polygon of territory.coast) {
      for (const ring of polygon) {
        for (const [index, [x, y]] of ring.entries()) {
          if (index) {
            ctx.lineTo(territory.x + x, territory.y + y);
          } else {
            ctx.moveTo(territory.x + x, territory.y + y);
          }
        }
        ctx.closePath();
      }
    }
  }
  ctx.fill("evenodd");
  ctx.restore();
}
