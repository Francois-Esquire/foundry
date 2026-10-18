import { contours } from "d3-contour";
import { terrainContourLevels } from "../data/bindings";
import type { SpyglassData, Territory } from "../data/types";
import type { OceanField } from "./ocean-field";
import { insidePolygons } from "./polygons";
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
  data: SpyglassData,
  shore: OceanField
): ContourLine[] {
  const lines = data.territories.flatMap((territory) =>
    landContours(territory)
  );
  const { width, height, distances, outside, scale } = shore;
  for (const { field, intervals } of [
    { field: distances, intervals: coastalRings },
    { field: outside, intervals: archipelagoRings },
  ]) {
    const rings = contours()
      .size([width, height])
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
              (x * data.width) / width - data.width / 2,
              (y * data.height) / height - data.height / 2,
            ]),
            sea: true,
          });
        }
      }
    }
  }
  return lines.sort((a, b) => Number(b.major) - Number(a.major));
}
