import { type ArchipelagoPlatform, boxMean } from "./archipelago-platform";
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
  domainWarp,
  type FractalSettings,
  fbm,
  noiseSeed,
  ridgedFbm,
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
 * Every cell keeps the sign of its signed distance, so every shoreline is
 * still an island's surveyed coast.
 */

/** The deep seabed's relief: where it appears and how strong it is. */
export interface SeabedDetailSettings {
  /** Low-amplitude roughness of the abyssal plain. */
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
  /** Erosion-like ridging that gathers where the seabed slopes. */
  ridges: FractalSettings & {
    /** Elevation units of the ridging at full strength. */
    amplitude: number;
    /** The ridged value at which the ridging neither raises nor carves. */
    bias: number;
    /** Map units per lattice cell of the ridging. */
    wavelength: number;
  };
  /** Seeds every noise field of the pass. */
  seed: string;
  /** Slope, in elevation per map unit, where ridging begins and where it is full. */
  slope: { full: number; start: number };
  /** Multiplies the whole pass; 0 turns it off. */
  strength: number;
  /** Meanders the ridges and fans: map units of displacement and of its wavelength. */
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
  /** Share, 0 to 1, of a span between two levels that each riser takes. */
  softness: number;
  /** 0 keeps the continuous field; 1 makes every tread flat. */
  strength: number;
}

export interface WorldTerrainSettings {
  /** Most recent world terrains kept by content. */
  cacheEntries: number;
  detail: SeabedDetailSettings;
  terrace: TerraceSettings;
}

export const defaultWorldTerrainSettings: WorldTerrainSettings = {
  cacheEntries: 4,
  detail: {
    abyss: {
      amplitude: 0.045,
      gain: 0.5,
      lacunarity: 2,
      octaves: 5,
      wavelength: 120,
    },
    // The platform's outer edge, 100 m: treads above it stay clean.
    clearAbove: elevationAtDepth(100),
    fans: {
      amplitude: 0.1,
      gain: 0.5,
      lacunarity: 2,
      octaves: 3,
      reach: 64,
      slope: { full: 0.008, start: 0.002 },
      wavelength: 56,
    },
    // The middle of the continental slope band, 500 m.
    fullBelow: elevationAtDepth(500),
    ridges: {
      amplitude: 0.1,
      bias: 0.45,
      gain: 0.5,
      lacunarity: 2,
      octaves: 4,
      wavelength: 34,
    },
    seed: "spyglass:seabed",
    slope: { full: 0.016, start: 0.003 },
    strength: 1,
    warp: {
      amplitude: 24,
      gain: 0.5,
      lacunarity: 2,
      octaves: 2,
      wavelength: 160,
    },
  },
  terrace: {
    levels: contourLevels()
      .filter(({ kind }) => kind === "bathymetric")
      .map(({ metres }) => metres)
      .sort((a, b) => a - b),
    minTread: 16,
    softness: 0.4,
    strength: 0.85,
  },
};

export interface WorldTerrainOptions {
  /** Seabed features, added to sea cells only. */
  contributions?: readonly SeabedContribution[];
  /** The islands whose coasts the structural terrain measured; they own its land cells. */
  islands: readonly TerrainIsland[];
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
  /** The owning islands' ids, sorted; `owner` indexes it. */
  islandIds: readonly string[];
  /** Index into `islandIds` of each land cell's island, row-major; -1 at sea. */
  owner: Int32Array;
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

/** What the detail pass derives once from its settings: its seeds and its warp. */
interface DetailContext {
  seeds: { abyss: number; fans: number; ridges: number; warp: number };
  warp: WarpSettings;
}

/** Where one sea cell's relief is asked for, and how its surroundings slope. */
interface DetailSample {
  /** 0 to 1: how far the cell lies below `clearAbove` toward `fullBelow`. */
  depthWeight: number;
  /** Mean slope within the fans' reach, elevation per map unit. */
  nearSlope: number;
  /** Slope at the cell, elevation per map unit. */
  slope: number;
  x: number;
  y: number;
}

/**
 * The deep seabed's relief at one sea cell, in elevation units: abyssal
 * roughness wherever the water is deep; warped ridged fBm where it is also
 * steep, the furrows of erosion down a slope; and sediment fans where the
 * cell is gentle but the seabed above it is steep, lobes deposited at a
 * slope's foot. All of it fades to nothing above `clearAbove`, so the
 * platform and the shallows stay clean.
 */
function seabedDetail(
  sample: DetailSample,
  detail: SeabedDetailSettings,
  context: DetailContext
): number {
  const { abyss, fans, ridges } = detail;
  const { seeds } = context;
  const { x, y } = sample;
  let value =
    abyss.amplitude *
    fbm(x / abyss.wavelength, y / abyss.wavelength, seeds.abyss, abyss);
  const slopeWeight = smoothstep(
    detail.slope.start,
    detail.slope.full,
    sample.slope
  );
  const fanWeight =
    smoothstep(fans.slope.start, fans.slope.full, sample.nearSlope) *
    (1 - slopeWeight);
  if (slopeWeight > 0 || fanWeight > 0) {
    const [wx, wy] = domainWarp(x, y, seeds.warp, context.warp);
    if (slopeWeight > 0 && ridges.amplitude > 0) {
      const ridge = ridgedFbm(
        wx / ridges.wavelength,
        wy / ridges.wavelength,
        seeds.ridges,
        ridges
      );
      value += ridges.amplitude * slopeWeight * (ridge - ridges.bias);
    }
    if (fanWeight > 0 && fans.amplitude > 0) {
      const lobe = fbm(
        wx / fans.wavelength,
        wy / fans.wavelength,
        seeds.fans,
        fans
      );
      value += fans.amplitude * fanWeight * Math.max(0, lobe + 0.35);
    }
  }
  return detail.strength * sample.depthWeight * value;
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
  const context: DetailContext = {
    seeds: {
      abyss: noiseSeed(`${detail.seed}:abyss`),
      fans: noiseSeed(`${detail.seed}:fans`),
      ridges: noiseSeed(`${detail.seed}:ridges`),
      warp: noiseSeed(`${detail.seed}:warp`),
    },
    warp: { ...detail.warp, frequency: 1 / detail.warp.wavelength },
  };
  const slopes = seaSlopes(reference, signedDistance, grid);
  const nearSlopes = slopes.slice();
  boxMean(
    nearSlopes,
    grid.width,
    grid.height,
    Math.max(1, Math.round(detail.fans.reach / grid.cell))
  );
  for (let row = 0; row < grid.height; row += 1) {
    for (let column = 0; column < grid.width; column += 1) {
      const at = row * grid.width + column;
      // Depth below the water rises from `clearAbove` down to `fullBelow`.
      const depthWeight = smoothstep(
        -detail.clearAbove,
        -detail.fullBelow,
        -(reference[at] ?? 0)
      );
      if ((signedDistance[at] ?? 0) < 0 || depthWeight <= 0) {
        continue;
      }
      const value = seabedDetail(
        {
          depthWeight,
          nearSlope: nearSlopes[at] ?? 0,
          slope: slopes[at] ?? 0,
          x: grid.left + (column + 0.5) * grid.cell,
          y: grid.top + (row + 0.5) * grid.cell,
        },
        detail,
        context
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
  const half = Math.min(0.5, Math.max(0, terrace.softness) / 2);
  for (const [at, height] of elevation.entries()) {
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
    const stepped = t + weight * (terraceStep(t, half) - t);
    elevation[at] = Math.min(
      upper,
      Math.max(lower, lower + stepped * (upper - lower))
    );
  }
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
  const base =
    options.platform?.seabed ?? (options.surface ?? terrain.surface).elevation;
  const { signedDistance } = terrain;
  const landform = options.landform ?? rampLandform(terrain.settings.land);
  const { islandIds, owner } = landOwners(
    grid,
    signedDistance,
    options.islands
  );
  const seabed = seabedSum(options.contributions ?? [], signedDistance, grid);
  const elevation = new Float32Array(grid.width * grid.height);
  for (let row = 0; row < grid.height; row += 1) {
    for (let column = 0; column < grid.width; column += 1) {
      const at = row * grid.width + column;
      const distance = signedDistance[at] ?? 0;
      if (distance < 0) {
        const height = landform({
          inland: -distance,
          islandId: islandIds[owner[at] ?? -1] ?? "",
          x: grid.left + (column + 0.5) * grid.cell,
          y: grid.top + (row + 0.5) * grid.cell,
        });
        elevation[at] = Math.min(
          geologyLevels.land,
          Math.max(geologyLevels.waterLevel, height)
        );
        continue;
      }
      const floor = base[at] ?? geologyLevels.abyss;
      const added = seabed?.[at] ?? 0;
      elevation[at] = added
        ? Math.min(
            seaCeiling(floor),
            Math.max(geologyLevels.trenchFloor, floor + added)
          )
        : floor;
    }
  }
  const featured = elevation.slice();
  if (settings.terrace.strength > 0) {
    applyTerrace(elevation, signedDistance, grid, settings.terrace);
  }
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
    elevation,
    gradient: (x, y) => gradientGrid(grid, elevation, x, y),
    islandIds,
    key,
    owner,
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
    settings.terrace,
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
