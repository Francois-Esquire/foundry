import type { SpyglassData, Territory } from "../data/types";

function traceCoast(
  ctx: CanvasRenderingContext2D,
  territory: Territory,
  dx = 0,
  dy = 0
) {
  for (const polygon of territory.coast) {
    for (const ring of polygon) {
      for (const [index, [x, y]] of ring.entries()) {
        if (index) {
          ctx.lineTo(x + dx, y + dy);
        } else {
          ctx.moveTo(x + dx, y + dy);
        }
      }
      ctx.closePath();
    }
  }
}

export function traceLand(ctx: CanvasRenderingContext2D, data: SpyglassData) {
  for (const territory of data.territories) {
    traceCoast(ctx, territory, territory.x, territory.y);
  }
}
