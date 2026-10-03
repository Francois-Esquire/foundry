import { insidePolygons } from "../atmosphere";
import { reliefHachure } from "../codex/bindings";
import { unit } from "../geography";
import type { AtlasData, Territory } from "../types";
import { baseTerrainField, type TerrainField } from "./terrain-field";

interface Hachure {
  dx: number;
  dy: number;
  slope: number;
  x: number;
  y: number;
}

export interface ReliefInk {
  strokes: Hachure[];
  territory: Territory;
}

/** Short fall-line strokes sampled from the current terrain relief. */
export function createReliefInk(
  data: AtlasData,
  fieldFor: (territory: Territory) => TerrainField = baseTerrainField
): ReliefInk[] {
  return data.territories.map((territory) => {
    const terrain = fieldFor(territory);
    const points = territory.coast.flat(2);
    const left = Math.min(...points.map(([x]) => x));
    const right = Math.max(...points.map(([x]) => x));
    const top = Math.min(...points.map(([, y]) => y));
    const bottom = Math.max(...points.map(([, y]) => y));
    const strokes: Hachure[] = [];
    for (let row = top; row < bottom; row += 4) {
      for (let col = left; col < right; col += 4) {
        const seed = `${territory.id}:${row}:${col}`;
        const x = col + unit(seed) * 2;
        const y = row + unit(`${seed}:y`) * 2;
        if (!insidePolygons({ x, y }, territory.coast)) {
          continue;
        }
        const dx =
          (terrain.sample(x + 2, y).elevation -
            terrain.sample(x - 2, y).elevation) /
          4;
        const dy =
          (terrain.sample(x, y + 2).elevation -
            terrain.sample(x, y - 2).elevation) /
          4;
        const slope = Math.hypot(dx, dy);
        if (reliefHachure(slope).length > 0) {
          strokes.push({ dx: dx / slope, dy: dy / slope, slope, x, y });
        }
      }
    }
    return { strokes, territory };
  });
}

export function paintReliefInk(
  ctx: CanvasRenderingContext2D,
  relief: ReliefInk[],
  pixels: number
) {
  if (pixels < 1.2) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = "#645f4b";
  ctx.lineCap = "round";
  for (const { territory, strokes } of relief) {
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
    ctx.clip("evenodd");
    for (const stroke of strokes) {
      paintHachure(ctx, stroke, pixels);
    }
    ctx.restore();
  }
  ctx.restore();
}

function paintHachure(
  ctx: CanvasRenderingContext2D,
  stroke: Hachure,
  pixels: number
) {
  const { dx, dy, x, y, slope } = stroke;
  const { length, opacity } = reliefHachure(slope, pixels);
  ctx.globalAlpha = opacity;
  ctx.lineWidth = 0.5 / pixels;
  for (const offset of [-0.45, 0.45]) {
    ctx.beginPath();
    ctx.moveTo(x - dy * offset, y + dx * offset);
    ctx.quadraticCurveTo(
      x + dx * length * 0.5 - dy * (offset + 0.1),
      y + dy * length * 0.5 + dx * (offset + 0.1),
      x + dx * length - dy * offset * 0.65,
      y + dy * length + dx * offset * 0.65
    );
    ctx.stroke();
  }
}
