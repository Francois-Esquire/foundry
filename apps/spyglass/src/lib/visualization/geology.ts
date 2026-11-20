import { terrainLevels } from "./terrain";

export const geologyLevels = {
  ...terrainLevels,
  trenchFloor: -1.25,
} as const;

const depthKnots = [
  { depth: 0, elevation: 0 },
  { depth: 5, elevation: -0.03 },
  { depth: 20, elevation: -0.12 },
  { depth: 100, elevation: -0.3 },
  { depth: 500, elevation: -0.5 },
  { depth: 1000, elevation: -0.75 },
  { depth: 2000, elevation: terrainLevels.abyss },
  { depth: 4000, elevation: geologyLevels.trenchFloor },
] as const;

const landHeight = 600;

export const depthBands = [
  {
    from: 0,
    id: "shoreline",
    label: "Shoreline",
    note: "Pale turquoise, transparent",
    to: 5,
  },
  {
    from: 5,
    id: "shallows",
    label: "Shallows",
    note: "Vibrant aqua, high clarity",
    to: 20,
  },
  {
    from: 20,
    id: "shelf",
    label: "Shelf",
    note: "Teal, contour lines visible",
    to: 100,
  },
  {
    from: 100,
    id: "slope",
    label: "Slope",
    note: "Cobalt, reduced visibility",
    to: 1000,
  },
  {
    from: 1000,
    id: "deep",
    label: "Deep ocean",
    note: "Ultramarine, minimal detail",
    to: 2000,
  },
  {
    from: 2000,
    id: "trench",
    label: "Trenches",
    note: "Navy, atmospheric",
    to: Number.POSITIVE_INFINITY,
  },
] as const;

export type DepthBandId = (typeof depthBands)[number]["id"];

function between(
  value: number,
  from: number,
  to: number,
  a: number,
  b: number
): number {
  return a + ((value - from) / (to - from)) * (b - a);
}

export function nominalDepth(elevation: number): number {
  if (elevation >= 0) {
    return 0;
  }
  for (let index = 1; index < depthKnots.length; index += 1) {
    const upper = depthKnots[index - 1];
    const lower = depthKnots[index];
    if (upper && lower && elevation >= lower.elevation) {
      return between(
        elevation,
        upper.elevation,
        lower.elevation,
        upper.depth,
        lower.depth
      );
    }
  }
  const last = depthKnots.at(-1) ?? { depth: 0, elevation: -1 };
  return last.depth;
}

export function elevationAtDepth(depth: number): number {
  if (depth <= 0) {
    return 0;
  }
  for (let index = 1; index < depthKnots.length; index += 1) {
    const upper = depthKnots[index - 1];
    const lower = depthKnots[index];
    if (upper && lower && depth <= lower.depth) {
      return between(
        depth,
        upper.depth,
        lower.depth,
        upper.elevation,
        lower.elevation
      );
    }
  }
  return geologyLevels.trenchFloor;
}

export function nominalHeight(elevation: number): number {
  return Math.max(0, elevation) * landHeight;
}

export function elevationAtHeight(height: number): number {
  return Math.min(geologyLevels.land, Math.max(0, height) / landHeight);
}

export function depthBand(depth: number): DepthBandId {
  return depthBands.find((band) => depth < band.to)?.id ?? "trench";
}

export interface GeologyGrid {
  cell: number;
  height: number;
  left: number;
  top: number;
  width: number;
}

export function sampleGrid(
  grid: GeologyGrid,
  values: ArrayLike<number>,
  x: number,
  y: number
): number {
  const u = Math.min(
    grid.width - 1,
    Math.max(0, (x - grid.left) / grid.cell - 0.5)
  );
  const v = Math.min(
    grid.height - 1,
    Math.max(0, (y - grid.top) / grid.cell - 0.5)
  );
  const column = Math.min(grid.width - 2, Math.floor(u));
  const row = Math.min(grid.height - 2, Math.floor(v));
  const s = u - column;
  const t = v - row;
  const at = (c: number, r: number) =>
    values[Math.max(0, r) * grid.width + Math.max(0, c)] ?? 0;
  const north = at(column, row) * (1 - s) + at(column + 1, row) * s;
  const south = at(column, row + 1) * (1 - s) + at(column + 1, row + 1) * s;
  return north * (1 - t) + south * t;
}

export function gradientGrid(
  grid: GeologyGrid,
  values: ArrayLike<number>,
  x: number,
  y: number
): [number, number] {
  const h = grid.cell;
  return [
    (sampleGrid(grid, values, x + h, y) - sampleGrid(grid, values, x - h, y)) /
      (2 * h),
    (sampleGrid(grid, values, x, y + h) - sampleGrid(grid, values, x, y - h)) /
      (2 * h),
  ];
}

interface LandformSample {
  inland: number;
  islandId: string;
  pieceDepth?: number;
  x: number;
  y: number;
}

export type Landform = (sample: LandformSample) => number;

export function rampLandform(reach: number): Landform {
  return ({ inland }) =>
    geologyLevels.waterLevel +
    (geologyLevels.land - geologyLevels.waterLevel) *
      Math.min(1, inland / Math.max(reach, 1e-6));
}
