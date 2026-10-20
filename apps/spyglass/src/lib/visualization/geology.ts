import { terrainLevels } from "./terrain";

/**
 * The geology contract: one vertical convention, one grid shape, and the
 * function types the world terrain is composed from. The structural
 * terrain's levels are kept: water is 0, the open abyss is -1, and land rises
 * toward 1. Features may carve below the abyss, to `trenchFloor`. Every
 * primitive reads and writes elevation in these units; nominal metres exist
 * only for reading a level as a chart would, never for computing.
 */
export const geologyLevels = {
  ...terrainLevels,
  /** The deepest a carved feature reaches: a trench below the open abyss. */
  trenchFloor: -1.25,
} as const;

/**
 * Elevation and the nominal depth a chart would print, as matched knots:
 * piecewise linear between them, so each band of the legend is one span.
 * The legend's stops are 0, 20, 100, 500, 1,000 and 2,000 m. The open
 * abyss reads as 2,000 m, the edge of the trenches, which only carved
 * features pass. No band boundary sits on a structural cap (`shelfTop`
 * reads about 27 m, `basementTop` about 700 m): structure approaches its
 * caps asymptotically, and a contour on one would wander over flat seabed.
 */
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

/** Nominal metres of land at full land height, for reading heights only. */
const landHeight = 600;

/** The depth bands a chart names, shallow to deep, in nominal metres. */
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

/** Nominal metres of water over an elevation: 0 at or above the water level. */
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

/** The elevation whose nominal depth is `depth` metres: `nominalDepth`'s inverse. */
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

/** Nominal metres of land above the water at an elevation: 0 under water. */
export function nominalHeight(elevation: number): number {
  return Math.max(0, elevation) * landHeight;
}

/** The elevation whose nominal height is `height` metres: `nominalHeight`'s inverse, capped at full land. */
export function elevationAtHeight(height: number): number {
  return Math.min(geologyLevels.land, Math.max(0, height) / landHeight);
}

/** The band a nominal depth falls in; land and the waterline read as shoreline. */
export function depthBand(depth: number): DepthBandId {
  return depthBands.find((band) => depth < band.to)?.id ?? "trench";
}

/**
 * A regular grid over the chart, in map units: `left` and `top` are the
 * west and north edges, and row 0 is the chart's top. The structural
 * terrain's grid is one; every geology field shares the structural
 * terrain's grid so their cells line up.
 */
export interface GeologyGrid {
  cell: number;
  height: number;
  left: number;
  top: number;
  width: number;
}

/** A rectangle of a grid's cells, with values of its own: a crop. */
interface GridCrop {
  column: number;
  height: number;
  row: number;
  values: Float32Array;
  width: number;
}

/**
 * A field's value at a map position, bilinear between cell centres and
 * clamped to the grid's edge. Cell `(column, row)` is centred at
 * `left + (column + 0.5) * cell`, `top + (row + 0.5) * cell`.
 */
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

/** A field's gradient at a map position, per map unit, by central differences over one cell. */
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

/**
 * The one continuous elevation field under and above the water: the seabed
 * and the islands as its exposed peaks. Everything else (contours, water
 * optics, the seabed mesh, features' labels) reads this.
 */
export interface WorldField extends GeologyGrid {
  /** Elevation by cell, row-major, in `geologyLevels` units. */
  elevation: Float32Array;
  /** Elevation gradient per map unit at a map position. */
  gradient(x: number, y: number): [number, number];
  /** Content identity, for caches. */
  key: string;
  /** Bilinear elevation at a map position. */
  sample(x: number, y: number): number;
  /**
   * Map units to the nearest coast, negative inside one: by default the
   * structural terrain's, whose coasts are the islands' surveyed ones; in
   * the geology preview, a true distance rebuilt from the preview's coasts.
   * Inside a coast is land, save an atoll's lagoon and inlets.
   */
  signedDistance: Float32Array;
}

/** Where a landform is asked for its height: a cell inside one island's coast. */
export interface LandformSample {
  /** Map units inland from the island's coast; always 0 or more. */
  inland: number;
  islandId: string;
  /**
   * Map units inland of the deepest point of the land piece the cell
   * stands on, when the world terrain knows it: a small islet's is far
   * below its island's `depth`. Absent, read the island's own depth.
   */
  pieceDepth?: number;
  /** The map position of the cell. */
  x: number;
  y: number;
}

/**
 * An island's land surface: elevation at a land cell, from 0 at the coast
 * up to at most `geologyLevels.land`. It must be 0 at `inland` 0 so every
 * shoreline stays the island's coast. The one exception is the world
 * terrain's own landform, which carves each atoll's lagoon and inlets below
 * the water inside its coast: there, and only there, it is negative.
 */
export type Landform = (sample: LandformSample) => number;

/** The current land: a straight rise to full height `reach` map units inland. */
export function rampLandform(reach: number): Landform {
  return ({ inland }) =>
    geologyLevels.waterLevel +
    (geologyLevels.land - geologyLevels.waterLevel) *
      Math.min(1, inland / Math.max(reach, 1e-6));
}

/**
 * Elevation added to the seabed over a crop of the world grid: positive
 * raises (a ridge, a seamount), negative carves (a channel, a trench).
 * Composition adds it to sea cells only and keeps the result between
 * `geologyLevels.trenchFloor` and the higher of `seabedCeiling` and the
 * cell's own structural elevation, so a feature never makes a new coast,
 * never touches land, and never lowers water next to a coast that the
 * structural terrain already holds above the ceiling.
 */
export interface SeabedContribution extends GridCrop {
  id: string;
}

/** The highest any sea cell may be raised: just under the water level. */
export const seabedCeiling = -0.02;

/** The six formations an island may take. */
export const landformArchetypes = [
  "volcanic",
  "atoll",
  "plateau",
  "ridge",
  "cluster",
  "seamount",
] as const;

export type LandformArchetype = (typeof landformArchetypes)[number];
