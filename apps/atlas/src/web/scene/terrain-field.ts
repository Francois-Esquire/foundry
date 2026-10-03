import { insidePolygons } from "../atmosphere";
import {
  lowland,
  prominentFile,
  rangeBlend,
  shoreRamp,
  summitHeight,
  summitProfile,
  summitReach,
} from "../codex/bindings";
import type { Territory } from "../types";

// Fixed survey-space sampling, never a zoom-dependent mesh or level of detail.
const cell = 3;

/** Only prominent files (the package's landmarks) raise summits; the rest is lowland. */
function summitSamples(territory: Territory) {
  const { files } = territory;
  return files
    .filter((file) => {
      const lower = files.filter((other) => other.incoming < file.incoming);
      return prominentFile(file.incoming, lower.length / files.length);
    })
    .map((file) => {
      const height = summitHeight(file.incoming);
      return { height, reach: summitReach(height), x: file.x, y: file.y };
    })
    .filter((summit) => summit.height > 0);
}

function coastDistance(territory: Territory, x: number, y: number) {
  let distance = Number.POSITIVE_INFINITY;
  for (const polygon of territory.coast) {
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i += 1) {
        const a = ring[i - 1];
        const b = ring[i];
        if (!(a && b)) {
          continue;
        }
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)
          )
        );
        distance = Math.min(
          distance,
          Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)
        );
      }
    }
  }
  return distance;
}

function rangeHeight(
  summits: ReturnType<typeof summitSamples>,
  x: number,
  y: number
) {
  const hills: number[] = [];
  for (const summit of summits) {
    const distanceSquared = (summit.x - x) ** 2 + (summit.y - y) ** 2;
    if (distanceSquared < summit.reach * summit.reach) {
      hills.push(summitProfile(distanceSquared, summit.height));
    }
  }
  return rangeBlend(hills);
}

function cubic(a: number, b: number, c: number, d: number, t: number) {
  return (
    b +
    0.5 *
      t *
      (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)))
  );
}

/** Lowland and usage summits, sampled once and independent of zoom or package detail. */
export function createTerrainField(territory: Territory) {
  const points = territory.coast.flat(2);
  const left =
    Math.floor(Math.min(0, ...points.map(([x]) => x)) / cell) * cell - cell;
  const top =
    Math.floor(Math.min(0, ...points.map(([, y]) => y)) / cell) * cell - cell;
  const width =
    Math.ceil((Math.max(0, ...points.map(([x]) => x)) - left) / cell) + 2;
  const height =
    Math.ceil((Math.max(0, ...points.map(([, y]) => y)) - top) / cell) + 2;
  const summits = summitSamples(territory);
  const grid = new Float32Array(width * height);
  const coastal = new Uint8Array(grid.length);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const x = left + column * cell;
      const y = top + row * cell;
      if (insidePolygons({ x, y }, territory.coast)) {
        const clearance = coastDistance(territory, x, y);
        coastal[row * width + column] = Number(clearance < cell * 2);
        grid[row * width + column] =
          lowland(clearance) +
          rangeHeight(summits, x, y) * shoreRamp(clearance);
      }
    }
  }
  const at = (
    column: number,
    row: number,
    values: ArrayLike<number> = grid
  ) => {
    if (column < 0 || row < 0 || column >= width || row >= height) {
      return 0;
    }
    return values[row * width + column] ?? 0;
  };
  return {
    sample(x: number, y: number) {
      const column = (x - left) / cell;
      const row = (y - top) / cell;
      const i = Math.floor(column);
      const j = Math.floor(row);
      const u = column - i;
      const v = row - j;
      // Interpolation must not lift the surveyed shore or bridge a narrow inlet.
      const nearCoast =
        at(i, j, coastal) ||
        at(i + 1, j, coastal) ||
        at(i, j + 1, coastal) ||
        at(i + 1, j + 1, coastal);
      if (
        nearCoast &&
        (!insidePolygons({ x, y }, territory.coast) ||
          coastDistance(territory, x, y) < 1e-7)
      ) {
        return { elevation: 0 };
      }
      const horizontal = (offset: number) =>
        cubic(
          at(i - 1, j + offset),
          at(i, j + offset),
          at(i + 1, j + offset),
          at(i + 2, j + offset),
          u
        );
      return {
        elevation: Math.max(
          0,
          cubic(horizontal(-1), horizontal(0), horizontal(1), horizontal(2), v)
        ),
      };
    },
  };
}

export type TerrainField = ReturnType<typeof createTerrainField>;
const fields = new WeakMap<Territory, TerrainField>();
export function baseTerrainField(territory: Territory) {
  let field = fields.get(territory);
  if (!field) {
    field = createTerrainField(territory);
    fields.set(territory, field);
  }
  return field;
}
