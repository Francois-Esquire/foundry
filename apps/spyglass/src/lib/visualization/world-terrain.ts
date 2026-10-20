import {
  type ArchipelagoPlatform,
  boxMean,
  latticeSampler,
} from "./archipelago-platform";
import {
  type CoastIsland,
  type CoastSettings,
  coastMask,
  maskDistance,
  pieceDepths,
  previewCoasts,
} from "./coasts";
import { contourLevels } from "./contours";
import {
  elevationAtDepth,
  geologyLevels,
  gradientGrid,
  type Landform,
  rampLandform,
  type SeabedContribution,
  sampleGrid,
  seabedCeiling,
  type WorldField,
} from "./geology";
import {
  inletChannel,
  type Lagoon,
  type LagoonSettings,
  type LagoonSite,
  lagoonLandform,
  planLagoons,
} from "./lagoons";
import {
  domainWarp,
  type FractalSettings,
  fbm,
  gradientNoise,
  noiseSeed,
  type WarpSettings,
} from "./noise";
import { fillPolygon } from "./scanline-fill";
import type {
  StructuralTerrain,
  TerrainIsland,
  TerrainSurface,
} from "./terrain";

/**
 * The world terrain: one continuous elevation field under and above the
 * water, on the structural terrain's grid. Land cells take an island's
 * landform. Sea cells are composed in order: the structural seabed, raised
 * to the archipelago platform when one is given; seabed features added to
 * it; a terrace pass that steps the seabed into plates at the contour
 * levels; and a seeded detail pass that adds relief to the deep seabed.
 * By default every cell keeps the sign of the structural signed distance,
 * so every shoreline is an island's surveyed coast. Given `coasts`, the
 * land is instead the preview's coasts, cleaned and sculpted from the
 * surveyed ones (`coasts.ts`), with a true signed distance rebuilt from
 * them; given `lagoons` too, atolls' lagoons and inlets are carved below
 * the water inside their coasts (`lagoons.ts`). The default map never
 * reads either: only the geology preview asks for them.
 */

/** The deep seabed's relief: where it appears and how strong it is. */
export interface SeabedDetailSettings {
  /** Fine, low roughness of the deep seabed. */
  abyss: FractalSettings & {
    /** Elevation units of the roughness at full strength. */
    amplitude: number;
    /** Map units per lattice cell of the roughness. */
    wavelength: number;
  };
  /** Elevation above which the seabed stays clean: the platform and the shallows. */
  clearAbove: number;
  /**
   * Sediment fans: lobes of deposit on the gentle floor at the foot of a
   * slope, where the seabed within `reach` is steep but the cell itself is
   * not. They only raise.
   */
  fans: FractalSettings & {
    /** Elevation units of a fan at full strength. */
    amplitude: number;
    /** Map units around a cell within which steep seabed feeds a fan. */
    reach: number;
    /** Mean slope within `reach`, elevation per map unit, where fans begin and where they are full. */
    slope: { full: number; start: number };
    /** Map units per lattice cell of the lobes. */
    wavelength: number;
  };
  /** Elevation below which the detail is at full strength. */
  fullBelow: number;
  /**
   * Gullies and the ribs between them, down every slope: grain noise
   * averaged along the downslope line through each cell, so it streaks
   * downhill rather than across. Where the seabed is gentle there are none.
   */
  gullies: {
    /** Elevation units of a gully's depth or a rib's height at full strength. */
    amplitude: number;
    /** Scales a streak's mean, which averaging narrows, back toward the grain's own spread. */
    gain: number;
    /** Map units the downslope line runs either side of a cell. */
    length: number;
    /** Map units of the blur that smooths the slope's direction. */
    smoothing: number;
    /** Steps the downslope line takes either side of a cell. */
    steps: number;
    /** Map units per lattice cell of the grain across the slope. */
    wavelength: number;
  };
  /**
   * Abyssal hills: broad, sparse rises on the deep plain. They only raise,
   * and only where the noise passes `threshold.start`, so most of the plain
   * stays open between them.
   */
  hills: FractalSettings & {
    /** Elevation units of a hill at full strength. */
    amplitude: number;
    /** Noise values, -1 to 1, where hills begin and where they are full. */
    threshold: { full: number; start: number };
    /** Map units per lattice cell of the hills. */
    wavelength: number;
  };
  /**
   * The open plain's settling: elevation added where the seabed lies at or
   * near the abyss, from `from` down to `full`. The open abyss lies exactly on
   * the 2,000 m level; settled a little below it, the level outlines the hills
   * rather than wandering over flat seabed.
   */
  plain: { from: number; full: number; offset: number };
  /** Seeds every noise field of the pass. */
  seed: string;
  /** Slope, in elevation per map unit, where gullies begin and where they are full. */
  slope: { full: number; start: number };
  /** Multiplies the whole pass; 0 turns it off. */
  strength: number;
  /** Meanders the hills and fans: map units of displacement and of its wavelength. */
  warp: FractalSettings & { amplitude: number; wavelength: number };
}

/**
 * Stepped bathymetry: the seabed between two neighbouring levels is pulled
 * toward a near-flat tread halfway between them, and rises to the next
 * tread over a short riser that crosses the level. Every contour line the
 * chart draws at a level therefore runs along a riser, the edge of a
 * plate, and never wanders over a tread. A cell stays between the two
 * levels it started between, so the pass never moves a cell across a level
 * and never touches water shallower than the shallowest level. Where the
 * seabed is so steep that a tread would be narrower than `minTread`, the
 * steps fade back to the continuous field: the grid cannot draw them there.
 */
export interface TerraceSettings {
  /**
   * Nominal metres of the levels the risers cross, shallow to deep. By
   * default they are the bathymetric levels of `contourLevels()`, the one
   * list the contour lines and the shaded plate edges are drawn at.
   */
  levels: readonly number[];
  /** Map units of a span's width at which the steps are full; at half of it they are gone. */
  minTread: number;
  /**
   * Each riser's width across the slope: `width` map units, wide enough
   * that its place between cell centres shows and a plate's edge never
   * snaps to the cells, yet short beside a broad tread. It is never more
   * than the `most` share, 0 to 1, of a narrow span, and never less than the
   * `least` share of a broad one, so over seabed that is all but flat a
   * riser spreads wide rather than standing as a cliff on whichever line the
   * seabed happens to cross the level.
   */
  riser: { least: number; most: number; width: number };
  /** 0 keeps the continuous field; 1 makes every tread flat. */
  strength: number;
}

/**
 * The floor of water the preview's coasts open where the surveyed coast
 * held land, a bay cut into it: nominal metres at the new coast, falling
 * to `depth.far` `reach` map units out, the apron's depth at its coast.
 */
interface NearshoreSettings {
  depth: { far: number; near: number };
  reach: number;
}

export interface WorldTerrainSettings {
  /** Most recent world terrains kept by content. */
  cacheEntries: number;
  detail: SeabedDetailSettings;
  nearshore: NearshoreSettings;
  terrace: TerraceSettings;
}

export const defaultWorldTerrainSettings: WorldTerrainSettings = {
  cacheEntries: 4,
  detail: {
    abyss: {
      amplitude: 0.012,
      gain: 0.5,
      lacunarity: 2,
      octaves: 3,
      wavelength: 48,
    },
    // The platform's outer edge, 100 m: treads above it stay clean.
    clearAbove: elevationAtDepth(100),
    fans: {
      amplitude: 0.1,
      gain: 0.5,
      lacunarity: 2,
      octaves: 3,
      reach: 64,
      slope: { full: 0.006, start: 0.0015 },
      wavelength: 72,
    },
    // The middle of the continental slope band, 500 m.
    fullBelow: elevationAtDepth(500),
    gullies: {
      amplitude: 0.06,
      gain: 3,
      length: 44,
      smoothing: 24,
      steps: 5,
      wavelength: 24,
    },
    hills: {
      amplitude: 0.09,
      gain: 0.5,
      lacunarity: 2,
      octaves: 4,
      threshold: { full: 0.55, start: 0.08 },
      wavelength: 190,
    },
    // From the 1,500 m level down to the abyss; settled about 60 m.
    plain: {
      from: elevationAtDepth(1500),
      full: elevationAtDepth(1980),
      offset: -0.015,
    },
    seed: "spyglass:seabed",
    slope: { full: 0.012, start: 0.002 },
    strength: 1,
    warp: {
      amplitude: 36,
      gain: 0.5,
      lacunarity: 2,
      octaves: 2,
      wavelength: 220,
    },
  },
  nearshore: { depth: { far: 5, near: 1 }, reach: 8 },
  terrace: {
    levels: contourLevels()
      .filter(({ kind }) => kind === "bathymetric")
      .map(({ metres }) => metres)
      .sort((a, b) => a - b),
    minTread: 16,
    riser: { least: 0.06, most: 0.45, width: 12 },
    strength: 0.95,
  },
};

export interface WorldTerrainOptions {
  /**
   * The preview's coasts: the islands' surveyed coasts cleaned and sculpted
   * with these settings, and the land and signed distance rebuilt from
   * them. Without it the land is the structural terrain's.
   */
  coasts?: CoastSettings;
  /** Seabed features, added to sea cells only. */
  contributions?: readonly SeabedContribution[];
  /**
   * The islands whose coasts the structural terrain measured; they own its
   * land cells. With `coasts`, any files an island lists stay on land.
   */
  islands: readonly CoastIsland[];
  /** Atolls whose lagoons are carved, and how; only read with `coasts`. */
  lagoons?: { settings: LagoonSettings; sites: readonly LagoonSite[] };
  /** Every island's land surface; by default the structural terrain's ramp. */
  landform?: Landform;
  /** Content identity of a custom landform; without it the function's identity is used. */
  landformKey?: string;
  /**
   * The archipelago platform: its seabed replaces the structural one at
   * sea, and seabed features must have been built over the same seabed.
   */
  platform?: Pick<ArchipelagoPlatform, "key" | "seabed">;
  settings?: WorldTerrainSettings;
  /** The seabed to start from; by default the structural terrain's full composition. */
  surface?: TerrainSurface;
  terrain: StructuralTerrain;
}

export interface WorldTerrain extends WorldField {
  /**
   * What the detail pass added to each sea cell, row-major; 0 elsewhere. A
   * finer field rebuilds the seabed as the terrace pass's steps over
   * `featured`, plus this.
   */
  detail: Float32Array;
  /**
   * Each cell before the terrace and detail passes, row-major: the seabed
   * with its features and inlets, and the land as `elevation` holds it.
   */
  featured: Float32Array;
  /** The owning islands' ids, sorted; `owner` indexes it. */
  islandIds: readonly string[];
  /**
   * The islands with the coasts the land is built on: the preview's coasts
   * when `coasts` was given, else the islands as given. Anything that
   * draws the land at a finer spacing rasterises these.
   */
  islands: readonly TerrainIsland[];
  /** The atolls' planned lagoons; empty without `coasts` and `lagoons`. */
  lagoons: readonly Lagoon[];
  /**
   * The land surface the world's land cells were built from, at any map
   * position: the landform given, told each position's piece depth, with
   * the atolls' lagoons carved in. It is below the water only inside a
   * lagoon or an inlet. A finer lattice asks this rather than the landform.
   */
  landform: Landform;
  /**
   * Index into `islandIds` of each cell's island inside a coast, row-major;
   * -1 at sea. A lagoon's and an inlet's cells inside the coast keep their
   * atoll as owner, under water though they are.
   */
  owner: Int32Array;
  /** Each cell's piece depth inside a coast (see `LandformSample`), row-major; 0 at sea. */
  pieceDepth: Float32Array;
}

/** The grid fields a world terrain is built on. */
interface Grid {
  cell: number;
  height: number;
  left: number;
  top: number;
  width: number;
}

/**
 * Which island owns each land cell: the island whose coast contains the
 * cell's centre, filled as the structural terrain fills its coasts. A land
 * cell no coast claims (an island without a coast, or a float tie at an
 * edge) goes to the island whose footprint circle is nearest. Islands are
 * visited by id, so overlaps resolve the same way every build.
 */
export function landOwners(
  grid: Grid,
  signedDistance: ArrayLike<number>,
  islands: readonly TerrainIsland[]
): { islandIds: string[]; owner: Int32Array } {
  const sorted = [...islands].sort((a, b) => a.id.localeCompare(b.id));
  const owner = new Int32Array(grid.width * grid.height).fill(-1);
  for (const [index, island] of sorted.entries()) {
    claimCoast(owner, grid, signedDistance, island, index);
  }
  for (let row = 0; row < grid.height; row += 1) {
    for (let column = 0; column < grid.width; column += 1) {
      const at = row * grid.width + column;
      if ((signedDistance[at] ?? 0) < 0 && owner[at] === -1) {
        owner[at] = nearestIsland(
          sorted,
          grid.left + (column + 0.5) * grid.cell,
          grid.top + (row + 0.5) * grid.cell
        );
      }
    }
  }
  return { islandIds: sorted.map((island) => island.id), owner };
}

/** Fills one island's coast over its own bounds and claims the unowned land cells inside it. */
function claimCoast(
  owner: Int32Array,
  grid: Grid,
  signedDistance: ArrayLike<number>,
  island: TerrainIsland,
  index: number
): void {
  const points = island.coast.flatMap((polygon) => polygon[0] ?? []);
  if (!points.length) {
    return;
  }
  const xs = points.map(([x]) => (island.x + x - grid.left) / grid.cell);
  const ys = points.map(([, y]) => (island.y + y - grid.top) / grid.cell);
  const column = Math.max(0, Math.floor(Math.min(...xs)) - 1);
  const row = Math.max(0, Math.floor(Math.min(...ys)) - 1);
  const width = Math.min(grid.width, Math.ceil(Math.max(...xs)) + 1) - column;
  const height = Math.min(grid.height, Math.ceil(Math.max(...ys)) + 1) - row;
  if (width <= 0 || height <= 0) {
    return;
  }
  const mask = new Uint8Array(width * height);
  for (const polygon of island.coast) {
    fillPolygon(
      mask,
      width,
      height,
      polygon.map((ring) =>
        ring.map(([x, y]): [number, number] => [
          (island.x + x - grid.left) / grid.cell - column,
          (island.y + y - grid.top) / grid.cell - row,
        ])
      )
    );
  }
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const at = (row + r) * grid.width + column + c;
      if (
        mask[r * width + c] &&
        owner[at] === -1 &&
        (signedDistance[at] ?? 0) < 0
      ) {
        owner[at] = index;
      }
    }
  }
}

/** The index of the island whose footprint circle is nearest a point. */
function nearestIsland(
  islands: readonly TerrainIsland[],
  x: number,
  y: number
): number {
  let best = -1;
  let nearest = Number.POSITIVE_INFINITY;
  for (const [index, island] of islands.entries()) {
    const distance = Math.hypot(x - island.x, y - island.y) - island.radius;
    if (distance < nearest) {
      nearest = distance;
      best = index;
    }
  }
  return best;
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/**
 * The highest a changed sea cell may stand: `seabedCeiling`, or the
 * structural seabed itself where that already lies above it. Features and
 * detail never raise a cell past this, so they never make a coast.
 */
function seaCeiling(base: number): number {
  return Math.max(base, seabedCeiling);
}

/** Adds one feature's crop to the sea cells of `sum` it covers on the grid. */
function addFeature(
  sum: Float32Array,
  feature: SeabedContribution,
  signedDistance: ArrayLike<number>,
  grid: Grid
): void {
  const bottom = Math.min(feature.height, grid.height - feature.row);
  const right = Math.min(feature.width, grid.width - feature.column);
  for (let r = Math.max(0, -feature.row); r < bottom; r += 1) {
    for (let c = Math.max(0, -feature.column); c < right; c += 1) {
      const at = (feature.row + r) * grid.width + feature.column + c;
      if ((signedDistance[at] ?? 0) >= 0) {
        sum[at] = (sum[at] ?? 0) + (feature.values[r * feature.width + c] ?? 0);
      }
    }
  }
}

/** Every feature's crop added together over the sea cells; land cells stay 0. */
function seabedSum(
  contributions: readonly SeabedContribution[],
  signedDistance: ArrayLike<number>,
  grid: Grid
): Float32Array | undefined {
  if (!contributions.length) {
    return;
  }
  const sum = new Float32Array(grid.width * grid.height);
  for (const feature of contributions) {
    addFeature(sum, feature, signedDistance, grid);
  }
  return sum;
}

/** Slope magnitude, elevation per map unit, by central differences clamped at the grid's edge. */
function slopeAt(
  elevation: ArrayLike<number>,
  grid: Grid,
  column: number,
  row: number
): number {
  const west = Math.max(0, column - 1);
  const east = Math.min(grid.width - 1, column + 1);
  const north = Math.max(0, row - 1);
  const south = Math.min(grid.height - 1, row + 1);
  const dx =
    ((elevation[row * grid.width + east] ?? 0) -
      (elevation[row * grid.width + west] ?? 0)) /
    (Math.max(1, east - west) * grid.cell);
  const dy =
    ((elevation[south * grid.width + column] ?? 0) -
      (elevation[north * grid.width + column] ?? 0)) /
    (Math.max(1, south - north) * grid.cell);
  return Math.hypot(dx, dy);
}

/** Every sea cell's slope, elevation per map unit; 0 on land. */
function seaSlopes(
  elevation: Float32Array,
  signedDistance: ArrayLike<number>,
  grid: Grid
): Float32Array {
  const slopes = new Float32Array(grid.width * grid.height);
  for (let row = 0; row < grid.height; row += 1) {
    for (let column = 0; column < grid.width; column += 1) {
      const at = row * grid.width + column;
      if ((signedDistance[at] ?? 0) >= 0) {
        slopes[at] = slopeAt(elevation, grid, column, row);
      }
    }
  }
  return slopes;
}

/**
 * The detail pass's smooth noise fields, each sampled on a lattice a few
 * cells apart and read bilinearly: the abyss's roughness, the fans' lobes
 * and the hills' rise, the last two over the shared warp.
 */
interface DetailFields {
  abyss: (x: number, y: number) => number;
  fans: (x: number, y: number) => number;
  hills: (x: number, y: number) => number;
}

/** Lattice spacings, in grid cells, of the detail's noise fields. */
const detailSpacing = { abyss: 2, fans: 2, hills: 3 } as const;

function detailFields(grid: Grid, detail: SeabedDetailSettings): DetailFields {
  const seeds = {
    abyss: noiseSeed(`${detail.seed}:abyss`),
    fans: noiseSeed(`${detail.seed}:fans`),
    hills: noiseSeed(`${detail.seed}:hills`),
    warp: noiseSeed(`${detail.seed}:warp`),
  };
  const warp: WarpSettings = {
    ...detail.warp,
    frequency: 1 / detail.warp.wavelength,
  };
  const bounds = {
    height: grid.height * grid.cell,
    left: grid.left,
    top: grid.top,
    width: grid.width * grid.cell,
  };
  const { abyss, fans, hills } = detail;
  return {
    abyss: latticeSampler(bounds, detailSpacing.abyss * grid.cell, (x, y) =>
      fbm(x / abyss.wavelength, y / abyss.wavelength, seeds.abyss, abyss)
    ),
    fans: latticeSampler(bounds, detailSpacing.fans * grid.cell, (x, y) => {
      const [wx, wy] = domainWarp(x, y, seeds.warp, warp);
      return fbm(wx / fans.wavelength, wy / fans.wavelength, seeds.fans, fans);
    }),
    hills: latticeSampler(bounds, detailSpacing.hills * grid.cell, (x, y) => {
      const [wx, wy] = domainWarp(x, y, seeds.warp, warp);
      return fbm(
        wx / hills.wavelength,
        wy / hills.wavelength,
        seeds.hills,
        hills
      );
    }),
  };
}

/** Where one sea cell's relief is asked for, and how its surroundings slope. */
interface DetailSample {
  /** 0 to 1: how far the cell lies below `clearAbove` toward `fullBelow`. */
  depthWeight: number;
  /** The cell's downslope streak, -1 to 1, already weighted by its slope. */
  gully: number;
  /** Mean slope within the fans' reach, elevation per map unit. */
  nearSlope: number;
  /** 0 to 1: how far the cell lies on the open plain. */
  plainWeight: number;
  /** 0 to 1: how steep the cell is, from `slope.start` to `slope.full`. */
  slopeWeight: number;
  x: number;
  y: number;
}

/**
 * The deep seabed's relief at one sea cell, in elevation units: fine
 * roughness wherever the water is deep; gullies and ribs down the slopes;
 * sediment fans where the cell is gentle but the seabed above it is steep,
 * lobes deposited at a slope's foot; and on the open plain, a settling below
 * the abyss and sparse abyssal hills rising from it. All of it fades to
 * nothing above `clearAbove`, so the platform and the shallows stay clean.
 */
function seabedDetail(
  sample: DetailSample,
  detail: SeabedDetailSettings,
  fields: DetailFields
): number {
  const { abyss, fans, gullies, hills, plain } = detail;
  const { x, y } = sample;
  let value = abyss.amplitude * fields.abyss(x, y);
  value += gullies.amplitude * sample.gully;
  const fanWeight =
    smoothstep(fans.slope.start, fans.slope.full, sample.nearSlope) *
    (1 - sample.slopeWeight);
  if (fanWeight > 0 && fans.amplitude > 0) {
    value += fans.amplitude * fanWeight * Math.max(0, fields.fans(x, y) + 0.35);
  }
  const hillWeight = sample.plainWeight * (1 - sample.slopeWeight);
  if (hillWeight > 0 && hills.amplitude > 0) {
    value +=
      hills.amplitude *
      hillWeight *
      smoothstep(
        hills.threshold.start,
        hills.threshold.full,
        fields.hills(x, y)
      );
  }
  value += plain.offset * sample.plainWeight;
  return detail.strength * sample.depthWeight * value;
}

/** A field's value at fractional cell coordinates, bilinear and clamped to the grid. */
function bilinear(
  values: ArrayLike<number>,
  grid: Grid,
  u: number,
  v: number
): number {
  const cu = Math.min(grid.width - 1, Math.max(0, u));
  const cv = Math.min(grid.height - 1, Math.max(0, v));
  const column = Math.min(grid.width - 2, Math.floor(cu));
  const row = Math.min(grid.height - 2, Math.floor(cv));
  const s = cu - column;
  const t = cv - row;
  const at = row * grid.width + column;
  const north = (values[at] ?? 0) * (1 - s) + (values[at + 1] ?? 0) * s;
  const south =
    (values[at + grid.width] ?? 0) * (1 - s) +
    (values[at + grid.width + 1] ?? 0) * s;
  return north * (1 - t) + south * t;
}

/** Grain noise at every cell centre, computed only where `wanted` is set and around it. */
function grainField(
  wanted: Uint8Array,
  grid: Grid,
  wavelength: number,
  seed: number
): Float32Array {
  const grain = new Float32Array(grid.width * grid.height);
  const done = new Uint8Array(grid.width * grid.height);
  const reach = 1;
  for (let row = 0; row < grid.height; row += 1) {
    for (let column = 0; column < grid.width; column += 1) {
      if (!wanted[row * grid.width + column]) {
        continue;
      }
      for (
        let r = Math.max(0, row - reach);
        r <= Math.min(grid.height - 1, row + reach);
        r += 1
      ) {
        for (
          let c = Math.max(0, column - reach);
          c <= Math.min(grid.width - 1, column + reach);
          c += 1
        ) {
          const at = r * grid.width + c;
          if (!done[at]) {
            done[at] = 1;
            grain[at] = gradientNoise(
              (grid.left + (c + 0.5) * grid.cell) / wavelength,
              (grid.top + (r + 0.5) * grid.cell) / wavelength,
              seed
            );
          }
        }
      }
    }
  }
  return grain;
}

/**
 * Each sea cell's gully weight, 0 to 1, from its slope blurred over
 * `radius` cells, as the slope's direction is, so gullies run on across
 * the benches between risers. Land and water above `clearAbove` weigh 0.
 */
function gullyWeights(
  reference: Float32Array,
  slopes: Float32Array,
  signedDistance: ArrayLike<number>,
  grid: Grid,
  detail: SeabedDetailSettings,
  radius: number
): Float32Array {
  const weights = slopes.slice();
  boxMean(weights, grid.width, grid.height, radius);
  for (let at = 0; at < weights.length; at += 1) {
    const open =
      (signedDistance[at] ?? 0) >= 0 &&
      (reference[at] ?? 0) < detail.clearAbove;
    weights[at] = open
      ? smoothstep(detail.slope.start, detail.slope.full, weights[at] ?? 0)
      : 0;
  }
  return weights;
}

/** The field's gradient by cell, central differences clamped at the grid's edge, blurred over `radius` cells. */
function blurredGradient(
  reference: Float32Array,
  grid: Grid,
  radius: number
): { dx: Float32Array; dy: Float32Array } {
  const dx = new Float32Array(reference.length);
  const dy = new Float32Array(reference.length);
  for (let row = 0; row < grid.height; row += 1) {
    const north = Math.max(0, row - 1) * grid.width;
    const south = Math.min(grid.height - 1, row + 1) * grid.width;
    for (let column = 0; column < grid.width; column += 1) {
      const at = row * grid.width + column;
      const east = Math.min(grid.width - 1, column + 1);
      const west = Math.max(0, column - 1);
      dx[at] =
        (reference[row * grid.width + east] ?? 0) -
        (reference[row * grid.width + west] ?? 0);
      dy[at] =
        (reference[south + column] ?? 0) - (reference[north + column] ?? 0);
    }
  }
  boxMean(dx, grid.width, grid.height, radius);
  boxMean(dy, grid.width, grid.height, radius);
  return { dx, dy };
}

/** Cells within `span` cells of any weighted cell: where a downslope line may reach. */
function streakReach(
  weights: Float32Array,
  grid: Grid,
  span: number
): Uint8Array {
  const spread = Float32Array.from(weights, (weight) => (weight > 0 ? 1 : 0));
  boxMean(spread, grid.width, grid.height, span);
  return Uint8Array.from(spread, (value) => (value > 0 ? 1 : 0));
}

/** Grain averaged along the downslope line through one cell, `line.steps` steps of `line.stride` cells each way, scaled by `line.gain`. */
function streakAt(
  fields: { dx: Float32Array; dy: Float32Array; grain: Float32Array },
  grid: Grid,
  start: { column: number; row: number },
  line: { gain: number; steps: number; stride: number }
): number {
  let sum = fields.grain[start.row * grid.width + start.column] ?? 0;
  let taken = 1;
  for (const direction of [-1, 1]) {
    let u = start.column;
    let v = start.row;
    for (let step = 0; step < line.steps; step += 1) {
      const gx = bilinear(fields.dx, grid, u, v);
      const gy = bilinear(fields.dy, grid, u, v);
      const length = Math.hypot(gx, gy);
      if (length < 1e-9) {
        break;
      }
      u += (direction * line.stride * gx) / length;
      v += (direction * line.stride * gy) / length;
      sum += bilinear(fields.grain, grid, u, v);
      taken += 1;
    }
  }
  return Math.min(1, Math.max(-1, (line.gain * sum) / taken));
}

/**
 * Each sea cell's downslope streak, -1 to 1, weighted by its slope: grain
 * noise averaged along the line of steepest descent through the cell, up
 * and down the slope over `gullies.length` map units. A line integral
 * convolution: the streak varies across the slope at the grain's
 * wavelength and hardly at all down it, so it reads as gullies and the
 * ribs between them. The slope's direction and the weight's slope are both
 * blurred over `gullies.smoothing`.
 */
function gullyStreaks(
  reference: Float32Array,
  slopes: Float32Array,
  signedDistance: ArrayLike<number>,
  grid: Grid,
  detail: SeabedDetailSettings,
  seed: number
): Float32Array {
  const streaks = new Float32Array(grid.width * grid.height);
  const { gullies } = detail;
  if (gullies.amplitude === 0) {
    return streaks;
  }
  const radius = Math.max(1, Math.round(gullies.smoothing / (2 * grid.cell)));
  const weights = gullyWeights(
    reference,
    slopes,
    signedDistance,
    grid,
    detail,
    radius
  );
  if (!weights.some((weight) => weight > 0)) {
    return streaks;
  }
  const gradient = blurredGradient(reference, grid, radius);
  // The line visits cells up to its length away; the grain is needed there too.
  const reach = streakReach(
    weights,
    grid,
    Math.ceil(gullies.length / grid.cell) + 1
  );
  const fields = {
    ...gradient,
    grain: grainField(reach, grid, Math.max(gullies.wavelength, 1e-6), seed),
  };
  const steps = Math.max(1, Math.round(gullies.steps));
  const line = {
    gain: gullies.gain,
    steps,
    stride: gullies.length / grid.cell / steps,
  };
  for (let at = 0; at < streaks.length; at += 1) {
    const weight = weights[at] ?? 0;
    if (weight > 0) {
      const column = at % grid.width;
      const row = (at - column) / grid.width;
      streaks[at] = weight * streakAt(fields, grid, { column, row }, line);
    }
  }
  return streaks;
}

/**
 * Applies the detail pass to the sea cells of `elevation` in place, kept
 * between the trench floor and each cell's ceiling. Depth and slope are
 * read from `reference`, the seabed before terracing, so the relief follows
 * the seabed's shape rather than its steps.
 */
function applyDetail(
  elevation: Float32Array,
  reference: Float32Array,
  base: ArrayLike<number>,
  signedDistance: ArrayLike<number>,
  grid: Grid,
  detail: SeabedDetailSettings
): void {
  const fields = detailFields(grid, detail);
  const slopes = seaSlopes(reference, signedDistance, grid);
  const nearSlopes = slopes.slice();
  boxMean(
    nearSlopes,
    grid.width,
    grid.height,
    Math.max(1, Math.round(detail.fans.reach / grid.cell))
  );
  const streaks = gullyStreaks(
    reference,
    slopes,
    signedDistance,
    grid,
    detail,
    noiseSeed(`${detail.seed}:grain`)
  );
  const { plain } = detail;
  for (let row = 0; row < grid.height; row += 1) {
    for (let column = 0; column < grid.width; column += 1) {
      const at = row * grid.width + column;
      const height = reference[at] ?? 0;
      // Depth below the water rises from `clearAbove` down to `fullBelow`.
      const depthWeight = smoothstep(
        -detail.clearAbove,
        -detail.fullBelow,
        -height
      );
      if ((signedDistance[at] ?? 0) < 0 || depthWeight <= 0) {
        continue;
      }
      const value = seabedDetail(
        {
          depthWeight,
          gully: streaks[at] ?? 0,
          nearSlope: nearSlopes[at] ?? 0,
          plainWeight: smoothstep(-plain.from, -plain.full, -height),
          slopeWeight: smoothstep(
            detail.slope.start,
            detail.slope.full,
            slopes[at] ?? 0
          ),
          x: grid.left + (column + 0.5) * grid.cell,
          y: grid.top + (row + 0.5) * grid.cell,
        },
        detail,
        fields
      );
      elevation[at] = Math.min(
        seaCeiling(base[at] ?? 0),
        Math.max(geologyLevels.trenchFloor, (elevation[at] ?? 0) + value)
      );
    }
  }
}

/**
 * A staircase over a contour coordinate whose levels lie on the integers:
 * each span's middle is a flat tread and each integer the middle of a
 * riser `2 · half` wide. It is monotonic, continuous with a continuous
 * slope, equal to `c` on every integer and half-integer, and keeps `c`
 * within its own span.
 */
export function terraceStep(c: number, half: number): number {
  const level = Math.round(c);
  const offset = c - level;
  if (half <= 0) {
    return level + 0.5 * Math.sign(offset);
  }
  return level + smoothstep(-half, half, offset) - 0.5;
}

/**
 * Steps the sea cells of `elevation` in place into treads and risers
 * between the levels: a cell's coordinate within its span is drawn toward
 * the staircase by `strength`, faded where the span is narrower than
 * `minTread` across the slope, and read back as elevation in the same span.
 * Each riser takes its width across the slope at the cell, held between
 * its least and most shares of the span.
 * Cells deeper than the deepest level or shallower than the shallowest are
 * left as they are.
 */
function applyTerrace(
  elevation: Float32Array,
  signedDistance: ArrayLike<number>,
  grid: Grid,
  terrace: TerraceSettings
): void {
  const reference = elevation.slice();
  const knots = terrace.levels.map(elevationAtDepth).sort((a, b) => a - b);
  const [deepest] = knots;
  const shallowest = knots.at(-1);
  if (deepest === undefined || shallowest === undefined || knots.length < 2) {
    return;
  }
  const strength = Math.min(1, Math.max(0, terrace.strength));
  const most = Math.min(1, Math.max(0, terrace.riser.most));
  const least = Math.min(most, Math.max(0, terrace.riser.least));
  for (let at = 0; at < elevation.length; at += 1) {
    const height = elevation[at] ?? 0;
    if (
      (signedDistance[at] ?? 0) < 0 ||
      !(height > deepest && height < shallowest)
    ) {
      continue;
    }
    let span = 0;
    while ((knots[span + 1] ?? shallowest) <= height) {
      span += 1;
    }
    const lower = knots[span] ?? deepest;
    const upper = knots[span + 1] ?? shallowest;
    const t = (height - lower) / (upper - lower);
    const slope = slopeAt(
      reference,
      grid,
      at % grid.width,
      Math.floor(at / grid.width)
    );
    // Map units the span would take across the slope here.
    const tread =
      slope > 0 ? (upper - lower) / slope : Number.POSITIVE_INFINITY;
    const weight =
      strength * smoothstep(terrace.minTread / 2, terrace.minTread, tread);
    if (weight <= 0) {
      continue;
    }
    // The riser's share of this span: its width across it, held between its least and most shares.
    const half =
      Math.min(most, Math.max(least, terrace.riser.width / tread)) / 2;
    const stepped = t + weight * (terraceStep(t, half) - t);
    elevation[at] = Math.min(
      upper,
      Math.max(lower, lower + stepped * (upper - lower))
    );
  }
}

/** The land a world terrain is built on: its islands' coasts, their signed distance, and each cell's owner. */
interface WorldLand {
  islandIds: string[];
  islands: readonly TerrainIsland[];
  owner: Int32Array;
  signedDistance: Float32Array;
}

/**
 * The structural terrain's land, or with `coasts` the preview's: its
 * coasts traced, filled onto the grid, and measured again as a true signed
 * distance by the same half-cell convention the structural terrain keeps.
 */
function worldLand(options: WorldTerrainOptions, grid: Grid): WorldLand {
  const { terrain } = options;
  if (!options.coasts) {
    return {
      ...landOwners(grid, terrain.signedDistance, options.islands),
      islands: options.islands,
      signedDistance: terrain.signedDistance,
    };
  }
  const islands = previewCoasts(options.islands, options.coasts);
  const signedDistance = maskDistance(
    coastMask(grid, islands, options.coasts.holeArea),
    grid.width,
    grid.height,
    grid.cell
  );
  return {
    ...landOwners(grid, signedDistance, islands),
    islands,
    signedDistance,
  };
}

/**
 * The seabed the sea starts from. Where the preview's coasts open water
 * over land the structural terrain held, a bay, the floor falls from the
 * nearshore's near depth at the new coast to its far depth `reach` out.
 */
function startingSeabed(
  base: Float32Array,
  structural: ArrayLike<number>,
  signedDistance: ArrayLike<number>,
  nearshore: NearshoreSettings
): Float32Array {
  if (structural === signedDistance) {
    return base;
  }
  const seabed = base.slice();
  const { far, near } = nearshore.depth;
  for (let at = 0; at < seabed.length; at += 1) {
    const distance = signedDistance[at] ?? 0;
    if ((structural[at] ?? 0) < 0 && distance >= 0) {
      const t = Math.min(1, distance / Math.max(nearshore.reach, 1e-6));
      seabed[at] = elevationAtDepth(near + (far - near) * t);
    }
  }
  return seabed;
}

/** The piece depth of the land nearest a map position: its own cell's, or the deepest of its neighbours'. */
function pieceDepthAt(
  grid: Grid,
  depths: Float32Array,
  x: number,
  y: number
): number {
  const column = Math.floor((x - grid.left) / grid.cell);
  const row = Math.floor((y - grid.top) / grid.cell);
  const own = depths[row * grid.width + column] ?? 0;
  if (own > 0) {
    return own;
  }
  let deepest = 0;
  for (
    let r = Math.max(0, row - 1);
    r <= Math.min(grid.height - 1, row + 1);
    r += 1
  ) {
    for (
      let c = Math.max(0, column - 1);
      c <= Math.min(grid.width - 1, column + 1);
      c += 1
    ) {
      deepest = Math.max(deepest, depths[r * grid.width + c] ?? 0);
    }
  }
  return deepest;
}

/**
 * The world's land surface at any map position: the given landform held
 * between the water and full height, the atolls' lagoons carved below the
 * water, and a sample without its piece depth, as a finer lattice asks,
 * told the depth of the land nearest it.
 */
function worldLandform(
  options: WorldTerrainOptions,
  grid: Grid,
  lagoons: readonly Lagoon[],
  pieceDepth: Float32Array
): Landform {
  const given = options.landform ?? rampLandform(options.terrain.settings.land);
  const surveyed: Landform = (sample) =>
    Math.min(
      geologyLevels.land,
      Math.max(geologyLevels.waterLevel, given(sample))
    );
  const lagoonSettings = options.lagoons?.settings;
  const carved = lagoonSettings
    ? lagoonLandform(surveyed, lagoons, lagoonSettings)
    : surveyed;
  return (sample) =>
    carved(
      sample.pieceDepth === undefined
        ? {
            ...sample,
            pieceDepth: pieceDepthAt(grid, pieceDepth, sample.x, sample.y),
          }
        : sample
    );
}

/** What a sea cell is composed from: the seabed, its features and the inlets' channels. */
interface SeaSources {
  base: ArrayLike<number>;
  lagoonSettings: LagoonSettings | undefined;
  lagoons: readonly Lagoon[];
  seabed: Float32Array | undefined;
}

/** One sea cell before the terrace and detail passes: the seabed, its features added, an inlet's channel cut in. */
function seaElevation(sources: SeaSources, at: number, x: number, y: number) {
  const floor = sources.base[at] ?? geologyLevels.abyss;
  const added = sources.seabed?.[at] ?? 0;
  let value = added
    ? Math.min(
        seaCeiling(floor),
        Math.max(geologyLevels.trenchFloor, floor + added)
      )
    : floor;
  if (sources.lagoonSettings && sources.lagoons.length) {
    // An inlet's channel runs on past the coast, cutting into the seabed.
    const channel = inletChannel(sources.lagoons, sources.lagoonSettings, x, y);
    if (channel > 0) {
      value = Math.min(value, elevationAtDepth(channel));
    }
  }
  return value;
}

function buildWorldTerrain(
  options: WorldTerrainOptions,
  settings: WorldTerrainSettings,
  key: string
): WorldTerrain {
  const { terrain } = options;
  const grid: Grid = {
    cell: terrain.cell,
    height: terrain.height,
    left: terrain.left,
    top: terrain.top,
    width: terrain.width,
  };
  const { islandIds, islands, owner, signedDistance } = worldLand(
    options,
    grid
  );
  const base = startingSeabed(
    options.platform?.seabed ?? (options.surface ?? terrain.surface).elevation,
    terrain.signedDistance,
    signedDistance,
    settings.nearshore
  );
  const pieceDepth = pieceDepths(grid, signedDistance);
  const lagoons =
    options.coasts && options.lagoons
      ? planLagoons(
          { ...grid, islandIds, owner, signedDistance },
          options.lagoons.sites,
          options.lagoons.settings
        )
      : [];
  const landform = worldLandform(options, grid, lagoons, pieceDepth);
  const sea: SeaSources = {
    base,
    lagoonSettings: options.lagoons?.settings,
    lagoons,
    seabed: seabedSum(options.contributions ?? [], signedDistance, grid),
  };
  const elevation = new Float32Array(grid.width * grid.height);
  for (let at = 0; at < elevation.length; at += 1) {
    const distance = signedDistance[at] ?? 0;
    const x = grid.left + ((at % grid.width) + 0.5) * grid.cell;
    const y = grid.top + (Math.floor(at / grid.width) + 0.5) * grid.cell;
    // Inside a coast: land, or an atoll's lagoon and inlets below the water.
    elevation[at] =
      distance < 0
        ? landform({
            inland: -distance,
            islandId: islandIds[owner[at] ?? -1] ?? "",
            pieceDepth: pieceDepth[at] ?? 0,
            x,
            y,
          })
        : seaElevation(sea, at, x, y);
  }
  // Both passes touch sea cells only: cells inside a coast, the lagoons
  // and inlets among them, keep the landform's carving as it is.
  const featured = elevation.slice();
  if (settings.terrace.strength > 0) {
    applyTerrace(elevation, signedDistance, grid, settings.terrace);
  }
  const terraced = elevation.slice();
  if (settings.detail.strength > 0) {
    applyDetail(
      elevation,
      featured,
      base,
      signedDistance,
      grid,
      settings.detail
    );
  }
  return {
    ...grid,
    detail: Float32Array.from(
      elevation,
      (value, at) => value - (terraced[at] ?? 0)
    ),
    elevation,
    featured,
    gradient: (x, y) => gradientGrid(grid, elevation, x, y),
    islandIds,
    islands,
    key,
    lagoons,
    landform,
    owner,
    pieceDepth,
    sample: (x, y) => sampleGrid(grid, elevation, x, y),
    signedDistance,
  };
}

/** FNV-1a over a string, continuing from `hash`. */
function hashText(text: string, hash = 2_166_136_261): number {
  let h = hash;
  for (let index = 0; index < text.length; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: A deterministic 32-bit hash identifies cached terrain.
    h = Math.imul(h ^ text.charCodeAt(index), 16_777_619) >>> 0;
  }
  return h;
}

/** FNV-1a over a float field's bits, continuing from `hash`. */
function hashValues(values: Float32Array, hash = 2_166_136_261): number {
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
  let h = hash;
  for (const word of bits) {
    // biome-ignore lint/suspicious/noBitwiseOperators: A deterministic 32-bit hash identifies cached terrain.
    h = Math.imul(h ^ word, 16_777_619) >>> 0;
  }
  return h;
}

const landformIds = new WeakMap<Landform, number>();
let nextLandformId = 0;

/** A custom landform's identity: its key if given, else a stable id for the function itself. */
function landformIdentity(options: WorldTerrainOptions): string {
  if (!options.landform) {
    return `ramp:${options.terrain.settings.land}`;
  }
  if (options.landformKey !== undefined) {
    return `key:${options.landformKey}`;
  }
  let id = landformIds.get(options.landform);
  if (id === undefined) {
    nextLandformId += 1;
    id = nextLandformId;
    landformIds.set(options.landform, id);
  }
  return `function:${id}`;
}

/** Content identity for the world terrain cache, never a security hash. */
function worldTerrainKey(
  options: WorldTerrainOptions,
  settings: WorldTerrainSettings
): string {
  const { terrain } = options;
  const surface =
    !options.surface || options.surface === terrain.surface
      ? "surface"
      : hashValues(options.surface.elevation).toString(16);
  const islands = [...options.islands]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((island) => [
      island.id,
      island.x,
      island.y,
      island.radius,
      island.coast,
      // Files shape only the preview's coasts.
      options.coasts
        ? (island.files ?? []).map((file) => [file.x, file.y])
        : null,
    ]);
  let contributions = 2_166_136_261;
  for (const feature of options.contributions ?? []) {
    contributions = hashText(
      JSON.stringify([
        feature.id,
        feature.column,
        feature.row,
        feature.width,
        feature.height,
      ]),
      contributions
    );
    contributions = hashValues(feature.values, contributions);
  }
  const json = JSON.stringify([
    terrain.key,
    options.platform?.key ?? "",
    surface,
    landformIdentity(options),
    settings.detail,
    settings.nearshore,
    settings.terrace,
    options.coasts ?? null,
    options.lagoons ?? null,
    islands,
  ]);
  return `${terrain.key}/${hashText(json).toString(16)}:${contributions.toString(16)}`;
}

const cache = new Map<string, WorldTerrain>();

/**
 * The world terrain for a structural terrain, its islands, and its seabed
 * features, built once per content and reused while it is unchanged. The
 * cache keeps the most recently used `cacheEntries` terrains.
 */
export function worldTerrain(options: WorldTerrainOptions): WorldTerrain {
  const settings = options.settings ?? defaultWorldTerrainSettings;
  const key = worldTerrainKey(options, settings);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const world = buildWorldTerrain(options, settings, key);
  cache.set(key, world);
  while (cache.size > Math.max(1, settings.cacheEntries)) {
    const [oldest] = cache.keys();
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
  return world;
}
