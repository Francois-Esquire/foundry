import { contours } from "d3-contour";
import { insidePolygons } from "../atmosphere";
import { terrainContourLevels } from "../codex/bindings";
import type { AtlasData, Polygon, Territory } from "../types";
import type { InkView, MapLabel } from "./exploration";
import { oceanField } from "./ocean";
import { baseTerrainField, type TerrainField } from "./terrain-field";

export interface ContourLine {
  elevation: number;
  major: boolean;
  opacity: number;
  points: [number, number][];
  sea: boolean;
}

export const coastalRings = [2, 3.5, 5.5, 8, 11.5, 15.5, 20];
export const archipelagoRings = [3, 4.5, 6.5, 9.5, 13, 17, 22];

const grids = new WeakMap<Territory, ReturnType<typeof buildContourGrid>>();
const landLines = new WeakMap<
  Territory,
  WeakMap<TerrainField, ContourLine[]>
>();

function buildContourGrid(p: Territory) {
  const coast = p.coast.flat(2);
  const cell = 1;
  const left = Math.min(...coast.map(([x]) => x)) - cell;
  const top = Math.min(...coast.map(([, y]) => y)) - cell;
  const width = Math.ceil(
    (Math.max(...coast.map(([x]) => x)) - left + cell) / cell
  );
  const height = Math.ceil(
    (Math.max(...coast.map(([, y]) => y)) - top + cell) / cell
  );
  const land = Uint8Array.from({ length: width * height }, (_, i) =>
    Number(
      insidePolygons(
        {
          x: left + ((i % width) + 0.5) * cell,
          y: top + (Math.floor(i / width) + 0.5) * cell,
        },
        p.coast
      )
    )
  );
  return { cell, height, land, left, top, width };
}

function contourGrid(p: Territory) {
  let grid = grids.get(p);
  if (!grid) {
    grid = buildContourGrid(p);
    grids.set(p, grid);
  }
  return grid;
}

/** Coast masks survive field changes; contour lines survive camera/detail changes. */
export function landContours(
  p: Territory,
  terrain: TerrainField = baseTerrainField(p)
) {
  let fields = landLines.get(p);
  if (!fields) {
    fields = new WeakMap();
    landLines.set(p, fields);
  }
  let lines = fields.get(terrain);
  if (!lines) {
    lines = buildLandContours(p, terrain);
    fields.set(terrain, lines);
  }
  return lines;
}

function buildLandContours(
  p: Territory,
  terrain: TerrainField = baseTerrainField(p)
): ContourLine[] {
  const coast = p.coast.flat(2);
  if (!coast.length) {
    return [];
  }
  const { cell, left, top, width, height, land } = contourGrid(p);
  const field = Array.from(land, (inside, i) => {
    const x = left + ((i % width) + 0.5) * cell;
    const y = top + (Math.floor(i / width) + 0.5) * cell;
    return inside ? terrain.sample(x, y).elevation : 0;
  });
  return contours()
    .size([width, height])
    .thresholds(terrainContourLevels)(field)
    .flatMap((c) =>
      c.coordinates.flatMap((polygon) =>
        polygon.map((ring) => ({
          elevation: c.value,
          major: terrainContourLevels.indexOf(c.value) % 2 === 1,
          opacity: 1,
          points: ring.map(([x = 0, y = 0]): [number, number] => [
            p.x + left + x * cell,
            p.y + top + y * cell,
          ]),
          sea: false,
        }))
      )
    );
}

export function createTopography(
  data: AtlasData,
  coasts?: Polygon[]
): ContourLine[] {
  const lines = data.territories.flatMap((territory) =>
    landContours(territory)
  );
  const { canvas, distances, outside, scale } = oceanField(data, 1280, coasts);
  for (const { field, intervals } of [
    { field: distances, intervals: coastalRings },
    { field: outside, intervals: archipelagoRings },
  ]) {
    const rings = contours()
      .size([canvas.width, canvas.height])
      .thresholds(intervals.map((d) => -d).reverse())(
      Array.from(field, (d) => -d / scale)
    );
    for (const c of rings) {
      for (const polygon of c.coordinates) {
        for (const ring of polygon) {
          lines.push({
            elevation: 0,
            major: -c.value === intervals[2] || -c.value === intervals[5],
            opacity: 1 - 0.6 * (-c.value / (intervals.at(-1) ?? 1)),
            points: ring.map(([x = 0, y = 0]) => [
              (x * data.width) / canvas.width - data.width / 2,
              (y * data.height) / canvas.height - data.height / 2,
            ]),
            sea: true,
          });
        }
      }
    }
  }
  return lines.sort((a, b) => Number(b.major) - Number(a.major));
}

export function paintTopography(
  ctx: CanvasRenderingContext2D,
  lines: ContourLine[],
  view: InkView,
  labels: MapLabel[]
): void {
  const pixels = view.pixelsPerUnit;
  const opacity = ctx.globalAlpha;
  const occupied = new Map<string, number>();
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    view.x - view.width / 2,
    view.y - view.height / 2,
    view.width,
    view.height
  );
  for (const label of labels) {
    ctx.rect(
      label.x - label.width / 2 - 4 / pixels,
      label.y - label.height - 4 / pixels,
      label.width + 8 / pixels,
      label.height + 8 / pixels
    );
  }
  ctx.clip("evenodd");
  ctx.setLineDash([]);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  paintTopographyEntries(lines, pixels, ctx, opacity, occupied, view, labels);
  ctx.restore();
}

function paintTopographyEntries(
  lines: ContourLine[],
  pixels: number,
  ctx: CanvasRenderingContext2D,
  opacity: number,
  occupied: Map<string, number>,
  view: InkView,
  labels: MapLabel[]
) {
  for (const [id, line] of lines.entries()) {
    const detail = line.major
      ? 1
      : Math.max(0, Math.min(1, (pixels - 1.1) / 1.2));
    if (!detail) {
      continue;
    }
    ctx.strokeStyle = line.sea ? "#487f78" : "#806c4f";
    ctx.globalAlpha =
      opacity * detail * line.opacity * (line.major ? 0.34 : 0.21);
    ctx.lineWidth = (line.major ? 0.7 : 0.45) / pixels;
    ctx.beginPath();
    let drawing = false;
    drawing = paintTopographyEntriesEntries(
      line,
      pixels,
      occupied,
      view,
      id,
      labels,
      drawing,
      ctx
    );
    ctx.stroke();
  }
}

function paintTopographyEntriesEntries(
  line: ContourLine,
  pixels: number,
  occupied: Map<string, number>,
  view: InkView,
  id: number,
  labels: MapLabel[],
  initialDrawing: boolean,
  ctx: CanvasRenderingContext2D
): boolean {
  let drawing = initialDrawing;
  for (const [x, terrainY] of line.points) {
    const y = terrainY;
    const key = `${Math.floor((x * pixels) / 3)}:${Math.floor((y * pixels) / 3)}`;
    const owner = occupied.get(key);
    const hidden =
      Math.abs(x - view.x) > view.width / 2 ||
      Math.abs(y - view.y) > view.height / 2 ||
      (owner !== undefined && owner !== id) ||
      labels.some(
        (l) =>
          Math.abs(x - l.x) < l.width / 2 + 4 / pixels &&
          y > l.y - l.height - 4 / pixels &&
          y < l.y + 4 / pixels
      );
    if (hidden) {
      drawing = false;
      continue;
    }
    occupied.set(key, id);
    if (drawing) {
      ctx.lineTo(x, y);
    } else {
      ctx.moveTo(x, y);
    }
    drawing = true;
  }
  return drawing;
}
