import { shoreDistances } from "./distance-field";
import { elevationAtDepth, type GeologyGrid, geologyLevels } from "./geology";
import {
  domainWarp,
  type FractalSettings,
  fbm,
  noiseSeed,
  ridgedFbm,
  type WarpSettings,
} from "./noise";
import { fillPolygon } from "./scanline-fill";
import {
  type StructuralTerrain,
  type TerrainIsland,
  type TerrainSurface,
  terrainLevels,
  terrainLift,
} from "./terrain";

/**
 * The archipelago platform: every package in one workspace frame shares the
 * workspace, so the frame's islands stand on one broad, shallow platform.
 * The platform's extent is a union of its islands: every cell within
 * `reach` of the frame's coasts, measured on the coast distance blurred by
 * `join`, so near neighbours share one platform without a waist between
 * them. Past the aprons, seeded noise displaces that distance, so the rim
 * runs in bays, lobes and spurs at several scales while every apron stays
 * clean. Its depth follows its rim and its islands: it deepens toward the
 * rim over `tilt`, and its interior sinks into basins away from the islands,
 * so terraces run as stacked plates. Past the rim an escarpment falls to the
 * deep in benches. Each island keeps a pale apron at its foot, its width
 * varied by noise, which blends into the platform. Each frame has its own
 * platform, and platforms of different frames never join.
 *
 * Composition: shelves and basements stand on the platform rather than on
 * the abyss. The share of the structural column a cell's structure fills,
 * from the abyss to `shelfTop`, is filled again of the column between the
 * platform floor and the apron's edge. The platformed seabed is the smooth
 * maximum of that and the structural seabed, never above the structural
 * seabed and the apron's coast level together, so a platform never lowers
 * a cell, never reaches `seabedCeiling`, and never makes a coast.
 */
export interface PlatformSettings {
  /** Nominal metres of water over the apron: at the coast's foot and at its outer edge. */
  apronDepth: { coast: number; edge: number };
  /** Map units over which the apron falls to the platform. */
  apronFall: number;
  /** Map units past the coast the apron runs before it falls to the platform. */
  apronReach: number;
  /**
   * How the apron wanders round an island: the share, 0 to 1, by which
   * broad noise widens or narrows its reach and its fall, that noise's
   * wavelength in map units, and finer noise that moves its edge in and out
   * by up to `edge.amplitude` map units, so no step round an island lies at
   * one distance from its coast.
   */
  apronVariation: FractalSettings & {
    edge: FractalSettings & { amplitude: number; wavelength: number };
    /** How many times the fall's mean slope the apron plunges past its fall, beneath any platform. */
    plunge: number;
    share: number;
    wavelength: number;
  };
  /**
   * The interior's basins: nominal metres the platform sinks below its inner
   * depth where it lies far from every coast, the map units past the
   * aprons' reach over which it sinks, and the noise that makes some basins deeper than
   * others, as a share of the depth and a wavelength in map units.
   */
  basins: FractalSettings & {
    depth: number;
    ramp: number;
    share: number;
    wavelength: number;
  };
  /** Smooth-maximum width, in elevation units, where an apron blends into the platform. */
  blend: number;
  /** Map units over which the rim falls from the platform's outer depth to the deep. */
  escarpment: number;
  /**
   * The escarpment's steps. Each bench is a depth in nominal metres, deepest
   * last; a riser falls to each bench in turn and a last riser falls to the
   * trench floor, each over a `riser` share of its step. The last `foot` map
   * units lie flat at the trench floor, under the open abyss. Each riser
   * wanders within its step by noise of `meander.wavelength` map units, up
   * to the `meander.amplitude` share, 0 to 1, of the step's flat run, and
   * every riser by its own mix of that noise, so the benches widen and
   * narrow independently and no contour runs parallel to the rim.
   */
  escarpmentSteps: {
    benches: readonly number[];
    foot: number;
    meander: { amplitude: number; wavelength: number };
    riser: number;
  };
  /**
   * Map units across the blur that joins the islands: the distance crest
   * between two neighbours is lowered by about a third of it, and the rim
   * is rounded.
   */
  join: number;
  /**
   * The rim's irregular outline: noise added to the joined distance, in map
   * units, full `ramp` map units past the aprons and nothing nearer. Ridged
   * noise, a `spurs` share of it, draws spurs out of the rim. The rim never
   * stands farther out than the foot's last flat run allows, so the open
   * abyss is untouched. An `amplitude` of 0 keeps the smooth outline.
   */
  outline: FractalSettings & {
    amplitude: number;
    ramp: number;
    spurs: number;
    warp: FractalSettings & { amplitude: number; wavelength: number };
    wavelength: number;
  };
  /** Nominal metres of water over the platform: in its interior, and at its rim. */
  platformDepth: { inner: number; outer: number };
  /** Map units past the joined coast distance to the platform's rim, where the escarpment begins. */
  reach: number;
  /** Seeds every noise field of the platform. */
  seed: string;
  /** Smooth-maximum width, in elevation units, where the platform meets the structural seabed. */
  smoothing: number;
  /** Share, 0 to 1, of the structural column that shelves and basements fill again above the platform. */
  structure: number;
  /** Map units inward from the rim over which the platform rises from its outer to its inner depth. */
  tilt: number;
}

export const defaultPlatformSettings: PlatformSettings = {
  apronDepth: { coast: 5, edge: 16 },
  apronFall: 36,
  apronReach: 18,
  apronVariation: {
    edge: {
      amplitude: 22,
      gain: 0.5,
      lacunarity: 2,
      octaves: 2,
      wavelength: 44,
    },
    gain: 0.5,
    lacunarity: 2,
    octaves: 3,
    plunge: 4,
    share: 0.5,
    wavelength: 80,
  },
  basins: {
    depth: 160,
    gain: 0.5,
    lacunarity: 2,
    octaves: 2,
    ramp: 60,
    share: 0.5,
    wavelength: 240,
  },
  blend: 0.03,
  escarpment: 150,
  // Each bench is the middle of a span between contour levels, so the
  // terrace pass leaves it where it is.
  escarpmentSteps: {
    benches: [175, 375, 875, 1750],
    foot: 40,
    meander: { amplitude: 0.85, wavelength: 70 },
    riser: 0.32,
  },
  join: 48,
  outline: {
    amplitude: 170,
    gain: 0.5,
    lacunarity: 2,
    octaves: 4,
    ramp: 50,
    spurs: 0.3,
    warp: {
      amplitude: 40,
      gain: 0.5,
      lacunarity: 2,
      octaves: 2,
      wavelength: 300,
    },
    wavelength: 300,
  },
  platformDepth: { inner: 45, outer: 90 },
  reach: 100,
  seed: "spyglass:platform",
  smoothing: 0.05,
  structure: 1,
  tilt: 72,
};

/** An island of one frame: the frame's id is its group. */
export interface PlatformIsland extends TerrainIsland {
  /** The workspace frame the island belongs to; islands of one group share a platform. */
  group: string;
}

export interface PlatformInput {
  islands: readonly PlatformIsland[];
  settings?: PlatformSettings;
  /** The seabed to raise; by default the structural terrain's full composition. */
  surface?: TerrainSurface;
  terrain: StructuralTerrain;
}

export interface ArchipelagoPlatform {
  /** Index into `groups` of the platform that stands above the abyss at each cell, row-major; -1 where none does. */
  frame: Int32Array;
  /** The platforms' groups, sorted; `frame` indexes it. */
  groups: readonly string[];
  /** Content identity, for caches. */
  key: string;
  /**
   * The platformed seabed by cell: the structural seabed raised to the
   * platform at sea, and the structural surface itself on land. Seabed
   * features read it and add to it.
   */
  seabed: Float32Array;
}

/** A crop of the grid with one value a cell. */
interface Crop {
  column: number;
  height: number;
  row: number;
  values: Float64Array;
  width: number;
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** A polynomial smooth maximum: exact where `a` and `b` differ by `k` or more, and at most `k / 4` above the higher. */
function blendMax(a: number, b: number, k: number): number {
  const highest = Math.max(a, b);
  if (k <= 0) {
    return highest;
  }
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return highest + (h * h * k) / 4;
}

/**
 * A polynomial smooth maximum, exact where `a` and `b` differ by `k` or
 * more, its blend scaled by the higher one's lift above the abyss, as the
 * structural terrain's is: at the abyss it is exactly the maximum.
 */
function smoothMax(a: number, b: number, k: number): number {
  const highest = Math.max(a, b);
  if (k <= 0) {
    return highest;
  }
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return highest + ((h * h * k) / 4) * terrainLift(highest);
}

/** Map units past the joined coast distance beyond which no platform stands. */
function platformLimit(settings: PlatformSettings): number {
  return settings.reach + settings.escarpment;
}

/** Elevation over a span of depths, linear in nominal metres. */
function depthBetween(from: number, to: number, t: number): number {
  return elevationAtDepth(from + (to - from) * Math.min(1, Math.max(0, t)));
}

/** The escarpment's steps: how many, how wide, and the flat run at their foot. */
function escarpmentLayout(settings: PlatformSettings) {
  const { escarpment, escarpmentSteps } = settings;
  const count = escarpmentSteps.benches.length + 1;
  const foot = Math.min(Math.max(0, escarpmentSteps.foot), escarpment);
  const step = (escarpment - foot) / count;
  const riser = Math.min(1, Math.max(1e-6, escarpmentSteps.riser));
  return { count, foot, riser, step };
}

/**
 * Map units at the escarpment's end that lie flat at the trench floor: the
 * last step's bench and the foot. The rim may stand this much farther out
 * than `reach` without raising the open abyss beyond the escarpment.
 */
function footRun(settings: PlatformSettings): number {
  const { foot, riser, step } = escarpmentLayout(settings);
  return foot + step * (1 - riser);
}

/**
 * An island's apron at a distance past the nearest coast of its frame: from
 * its coast depth to its edge depth over `apronReach`, then down to the
 * platform's outer depth over `apronFall`, and on down `apronVariation.plunge`
 * times more steeply, beneath any platform. `scale` widens or narrows the reach and the
 * fall, as the apron's variation does round an island.
 */
function apronFloor(
  distance: number,
  settings: PlatformSettings = defaultPlatformSettings,
  scale: { fall: number; reach: number } = { fall: 1, reach: 1 }
): number {
  const { apronDepth, platformDepth } = settings;
  const reach = Math.max(settings.apronReach * scale.reach, 1e-6);
  const fall = Math.max(settings.apronFall * scale.fall, 1e-6);
  if (distance <= reach) {
    return depthBetween(
      apronDepth.coast,
      apronDepth.edge,
      Math.max(0, distance) / reach
    );
  }
  if (distance <= reach + fall) {
    return depthBetween(
      apronDepth.edge,
      platformDepth.outer,
      smoothstep(reach, reach + fall, distance)
    );
  }
  const edge = elevationAtDepth(apronDepth.edge);
  const outer = elevationAtDepth(platformDepth.outer);
  return Math.max(
    geologyLevels.trenchFloor,
    outer -
      ((settings.apronVariation.plunge * (edge - outer)) / fall) *
        (distance - reach - fall)
  );
}

/**
 * Where each of the escarpment's risers stands within its step, 0 at the
 * step's start to 1 at the last place its riser fits: for the step of each
 * index, a share of the step's flat run.
 */
type RiserPlace = (index: number) => number;

/** Every riser at the start of its step. */
const risersAtStart: RiserPlace = () => 0;

/**
 * The escarpment's fall, 0 at the rim to 1 at its foot, at `outward` map
 * units past the rim, as elevation: a riser over a `riser` share of each
 * step down to the next bench, standing where `place` puts it in its step,
 * the bench either side of it, and after the last riser the flat foot at
 * the trench floor.
 */
function escarpmentFloor(
  outward: number,
  settings: PlatformSettings,
  place: RiserPlace = risersAtStart
): number {
  const { count, riser, step } = escarpmentLayout(settings);
  const levels = [
    elevationAtDepth(settings.platformDepth.outer),
    ...settings.escarpmentSteps.benches.map(elevationAtDepth),
    geologyLevels.trenchFloor,
  ];
  const s = Math.max(0, outward) / Math.max(step, 1e-6);
  const index = Math.min(count - 1, Math.floor(s));
  const from = levels[index] ?? geologyLevels.trenchFloor;
  const to = levels[index + 1] ?? geologyLevels.trenchFloor;
  const start = (1 - riser) * Math.min(1, Math.max(0, place(index)));
  return from + (to - from) * smoothstep(start, start + riser, s - index);
}

/**
 * The platform floor's elevation from a cell's place on it: `inward` map
 * units inside the rim, or `outward` past it, and `inner`, the nominal
 * metres of its interior there, by default `platformDepth.inner`. Inside,
 * the platform rises from its outer depth at the rim to its inner depth
 * `tilt` inward. Past the rim the escarpment falls in benches to the trench
 * floor, more than any smoothing width below the abyss, so the open abyss
 * is left exactly as it was.
 */
export function platformFloor(
  place: {
    inner?: number;
    inward: number;
    outward: number;
    risers?: RiserPlace;
  },
  settings: PlatformSettings = defaultPlatformSettings
): number {
  const { platformDepth } = settings;
  if (place.outward <= 0) {
    return depthBetween(
      platformDepth.outer,
      place.inner ?? platformDepth.inner,
      smoothstep(0, Math.max(settings.tilt, 1e-6), place.inward)
    );
  }
  return escarpmentFloor(place.outward, settings, place.risers);
}

/**
 * Map units from every cell of a crop to the nearest coast of a frame's
 * islands: the coasts filled on the grid, and the distance from each cell's
 * centre to the nearest land cell's centre less half a cell, so a cell
 * beside a coast reads about half a cell. The crop holds every island and
 * `limit` map units of water around them.
 */
function frameDistance(
  islands: readonly TerrainIsland[],
  grid: GeologyGrid,
  limit: number
): Crop | undefined {
  const points = islands.flatMap((island) =>
    island.coast.flatMap((polygon) =>
      (polygon[0] ?? []).map(([x, y]): [number, number] => [
        (island.x + x - grid.left) / grid.cell,
        (island.y + y - grid.top) / grid.cell,
      ])
    )
  );
  if (!points.length) {
    return;
  }
  const margin = Math.ceil(limit / grid.cell) + 1;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  const column = Math.max(0, Math.floor(left) - margin);
  const row = Math.max(0, Math.floor(top) - margin);
  const width = Math.min(grid.width, Math.ceil(right) + margin) - column;
  const height = Math.min(grid.height, Math.ceil(bottom) + margin) - row;
  if (width <= 0 || height <= 0) {
    return;
  }
  const land = new Uint8Array(width * height);
  for (const island of islands) {
    for (const polygon of island.coast) {
      fillPolygon(
        land,
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
  }
  if (!land.includes(1)) {
    return;
  }
  const distances = shoreDistances(land, width, height);
  const values = Float64Array.from(distances, (cells, at) =>
    land[at] ? 0 : Math.max(0, cells - 0.5) * grid.cell
  );
  return { column, height, row, values, width };
}

/**
 * A smooth field sampled on a lattice `spacing` map units apart and read
 * bilinearly between its points, each point evaluated on first use. For
 * noise whose finest wavelength spans several lattice spacings this is
 * close to evaluating it everywhere, at a fraction of the cost. The lattice
 * covers `bounds` and is clamped at its edge.
 */
export function latticeSampler(
  bounds: { height: number; left: number; top: number; width: number },
  spacing: number,
  evaluate: (x: number, y: number) => number
): (x: number, y: number) => number {
  const step = Math.max(spacing, 1e-6);
  const columns = Math.max(2, Math.ceil(bounds.width / step) + 2);
  const rows = Math.max(2, Math.ceil(bounds.height / step) + 2);
  const memo = new Float64Array(columns * rows).fill(Number.NaN);
  const at = (column: number, row: number): number => {
    const index = row * columns + column;
    let value = memo[index] ?? Number.NaN;
    if (Number.isNaN(value)) {
      value = evaluate(bounds.left + column * step, bounds.top + row * step);
      memo[index] = value;
    }
    return value;
  };
  return (x, y) => {
    const u = Math.min(columns - 1, Math.max(0, (x - bounds.left) / step));
    const v = Math.min(rows - 1, Math.max(0, (y - bounds.top) / step));
    const column = Math.min(columns - 2, Math.floor(u));
    const row = Math.min(rows - 2, Math.floor(v));
    const s = u - column;
    const t = v - row;
    const north = at(column, row) * (1 - s) + at(column + 1, row) * s;
    const south = at(column, row + 1) * (1 - s) + at(column + 1, row + 1) * s;
    return north * (1 - t) + south * t;
  };
}

/** The running mean of `line` over `radius` entries either side, clipped at its ends, into `out`. */
function slidingMean(
  line: Float64Array,
  radius: number,
  out: Float64Array
): void {
  const count = line.length;
  let sum = 0;
  let taken = 0;
  for (let i = 0; i < Math.min(radius, count); i += 1) {
    sum += line[i] ?? 0;
    taken += 1;
  }
  for (let i = 0; i < count; i += 1) {
    if (i + radius < count) {
      sum += line[i + radius] ?? 0;
      taken += 1;
    }
    if (i - radius - 1 >= 0) {
      sum -= line[i - radius - 1] ?? 0;
      taken -= 1;
    }
    out[i] = sum / taken;
  }
}

/**
 * A row-major field's mean over a square of `radius` cells about each
 * cell, in place: running sums along rows, then along columns, each
 * clipped at the field's edge.
 */
export function boxMean(
  values: Float32Array | Float64Array,
  width: number,
  height: number,
  radius: number
): void {
  const row = new Float64Array(width);
  const rowMean = new Float64Array(width);
  for (let r = 0; r < height; r += 1) {
    row.set(values.subarray(r * width, (r + 1) * width));
    slidingMean(row, radius, rowMean);
    values.set(rowMean, r * width);
  }
  const column = new Float64Array(height);
  const columnMean = new Float64Array(height);
  for (let c = 0; c < width; c += 1) {
    for (let r = 0; r < height; r += 1) {
      column[r] = values[r * width + c] ?? 0;
    }
    slidingMean(column, radius, columnMean);
    for (let r = 0; r < height; r += 1) {
      values[r * width + c] = columnMean[r] ?? 0;
    }
  }
}

/**
 * A frame's joined distance: its coast distance blurred twice by a box
 * `join` map units across, and never more than the distance itself. The
 * blur lowers the crest of distance that runs between two islands, by
 * about a third of `join`, so near neighbours share one platform without
 * a waist between them, and it rounds the platform's rim.
 */
function joinedDistance(distance: Crop, join: number, cell: number): Crop {
  const joined = { ...distance, values: Float64Array.from(distance.values) };
  const radius = Math.max(0, Math.round(join / (2 * cell)));
  if (radius > 0) {
    boxMean(joined.values, joined.width, joined.height, radius);
    boxMean(joined.values, joined.width, joined.height, radius);
  }
  for (const [at, value] of joined.values.entries()) {
    joined.values[at] = Math.min(value, distance.values[at] ?? value);
  }
  return joined;
}

/** What the platform derives once from its settings: its noise seeds and warp. */
interface PlatformNoise {
  seeds: {
    apronEdge: number;
    apronFall: number;
    apronReach: number;
    basins: number;
    benches: number;
    outline: number;
    spurs: number;
    warp: number;
  };
  warp: WarpSettings;
}

/**
 * The platform's noise fields over one frame's crop, each sampled on a
 * lattice and read bilinearly: the rim's displacement, the apron's reach,
 * fall and edge, the basins' depth, and two fields whose mix places each
 * of the escarpment's risers.
 */
interface PlatformFields {
  apronEdge: (x: number, y: number) => number;
  apronFall: (x: number, y: number) => number;
  apronReach: (x: number, y: number) => number;
  basins: (x: number, y: number) => number;
  benches: [(x: number, y: number) => number, (x: number, y: number) => number];
  outline: (x: number, y: number) => number;
}

/** Radians between the noise mixes of neighbouring risers, so each riser wanders its own way. */
const riserTurn = 2.2;

/**
 * Where each riser stands within its step at a map position: the two
 * bench fields mixed at an angle that turns from riser to riser, scaled to
 * the meander's amplitude and centred in the step's flat run. The last
 * riser, down to the trench floor, keeps to its step's start, so the foot
 * is as wide as the rim's reach allows for and the open abyss is untouched.
 */
function riserPlaces(
  fields: PlatformFields,
  settings: PlatformSettings,
  x: number,
  y: number
): RiserPlace {
  const { amplitude } = settings.escarpmentSteps.meander;
  if (amplitude <= 0) {
    return risersAtStart;
  }
  const a = fields.benches[0](x, y);
  const b = fields.benches[1](x, y);
  const last = settings.escarpmentSteps.benches.length;
  return (index) => {
    if (index >= last) {
      return 0;
    }
    const mix =
      a * Math.cos(index * riserTurn) + b * Math.sin(index * riserTurn);
    return 0.5 + 0.5 * amplitude * Math.max(-1, Math.min(1, 1.4 * mix));
  };
}

/** Lattice spacings, in grid cells, of the outline's and the apron's noise, and of the broad basins'. */
const fieldSpacing = { basins: 4, fine: 2 } as const;

function platformFields(
  union: Crop,
  grid: GeologyGrid,
  settings: PlatformSettings,
  noise: PlatformNoise
): PlatformFields {
  const bounds = {
    height: union.height * grid.cell,
    left: grid.left + union.column * grid.cell,
    top: grid.top + union.row * grid.cell,
    width: union.width * grid.cell,
  };
  const fine = fieldSpacing.fine * grid.cell;
  const { apronVariation, basins } = settings;
  const apron = Math.max(apronVariation.wavelength, 1e-6);
  const edge = Math.max(apronVariation.edge.wavelength, 1e-6);
  const basin = Math.max(basins.wavelength, 1e-6);
  const bench = Math.max(settings.escarpmentSteps.meander.wavelength, 1e-6);
  const benchSettings = { gain: 0.5, lacunarity: 2, octaves: 2 };
  return {
    apronEdge: latticeSampler(bounds, fine, (x, y) =>
      fbm(x / edge, y / edge, noise.seeds.apronEdge, apronVariation.edge)
    ),
    apronFall: latticeSampler(bounds, fine, (x, y) =>
      fbm(x / apron, y / apron, noise.seeds.apronFall, apronVariation)
    ),
    apronReach: latticeSampler(bounds, fine, (x, y) =>
      fbm(x / apron, y / apron, noise.seeds.apronReach, apronVariation)
    ),
    basins: latticeSampler(bounds, fieldSpacing.basins * grid.cell, (x, y) =>
      fbm(x / basin, y / basin, noise.seeds.basins, basins)
    ),
    benches: [
      latticeSampler(bounds, fine, (x, y) =>
        fbm(x / bench, y / bench, noise.seeds.benches, benchSettings)
      ),
      latticeSampler(bounds, fine, (x, y) =>
        fbm(
          x / bench + 31.7,
          y / bench - 12.9,
          noise.seeds.benches,
          benchSettings
        )
      ),
    ],
    outline: latticeSampler(bounds, fine, (x, y) =>
      outlineDisplacement(x, y, settings.outline, noise)
    ),
  };
}

function platformNoise(settings: PlatformSettings): PlatformNoise {
  const { seed } = settings;
  const { warp } = settings.outline;
  return {
    seeds: {
      apronEdge: noiseSeed(`${seed}:apron-edge`),
      apronFall: noiseSeed(`${seed}:apron-fall`),
      apronReach: noiseSeed(`${seed}:apron-reach`),
      basins: noiseSeed(`${seed}:basins`),
      benches: noiseSeed(`${seed}:benches`),
      outline: noiseSeed(`${seed}:outline`),
      spurs: noiseSeed(`${seed}:spurs`),
      warp: noiseSeed(`${seed}:warp`),
    },
    warp: { ...warp, frequency: 1 / Math.max(warp.wavelength, 1e-6) },
  };
}

/** Map units past the coast within which an apron may still stand: its widest reach and fall. */
function apronExtent(settings: PlatformSettings): number {
  const { apronVariation } = settings;
  const widest = 1 + Math.max(0, apronVariation.share);
  return (
    (settings.apronReach + settings.apronFall) * widest +
    Math.abs(apronVariation.edge.amplitude)
  );
}

/**
 * Map units past the coast beyond which every apron, at its widest, has
 * plunged to the trench floor, so it can stand above no platform floor.
 */
function apronLimit(settings: PlatformSettings): number {
  const { apronDepth, apronVariation, platformDepth } = settings;
  const fall = settings.apronFall * (1 + Math.max(0, apronVariation.share));
  const edge = elevationAtDepth(apronDepth.edge);
  const outer = elevationAtDepth(platformDepth.outer);
  const slope =
    (Math.max(apronVariation.plunge, 1e-6) * Math.max(edge - outer, 1e-6)) /
    fall;
  return apronExtent(settings) + (outer - geologyLevels.trenchFloor) / slope;
}

/** Map units past the coast of an apron's typical outer edge, where the rim's noise begins. */
function apronEdge(settings: PlatformSettings): number {
  return settings.apronReach + settings.apronFall;
}

/**
 * The rim's displacement at a map position, in map units: positive draws
 * the rim in, a bay; negative pushes it out, a lobe or a spur. Warped fBm
 * gives the bays and lobes at several scales, and warped ridged fBm the
 * spurs along its crests.
 */
function outlineDisplacement(
  x: number,
  y: number,
  outline: PlatformSettings["outline"],
  noise: PlatformNoise
): number {
  const [wx, wy] = domainWarp(x, y, noise.seeds.warp, noise.warp);
  const u = wx / Math.max(outline.wavelength, 1e-6);
  const v = wy / Math.max(outline.wavelength, 1e-6);
  const lobes = fbm(u, v, noise.seeds.outline, outline);
  const spurs =
    outline.spurs > 0
      ? ridgedFbm(u * 1.7, v * 1.7, noise.seeds.spurs, outline)
      : 0;
  return (
    outline.amplitude *
    ((1 - outline.spurs) * lobes - outline.spurs * (2 * spurs - 0.6))
  );
}

/**
 * Map units past the rim of one frame's platform at each cell of its
 * union, before any other frame is considered: the union's distance past
 * `reach`, displaced by the outline's noise. The noise is nothing within
 * the aprons' edge and full `ramp` map units past it, and the rim never
 * stands more than the escarpment's flat foot beyond `reach` of a coast.
 */
function outlineOffsets(
  frame: { distance: Crop; union: Crop },
  grid: GeologyGrid,
  settings: PlatformSettings,
  displacement: (x: number, y: number) => number
): Float64Array {
  const { distance, union } = frame;
  const { outline, reach } = settings;
  const outward = new Float64Array(union.values.length);
  const start = apronEdge(settings);
  const slack = 0.95 * footRun(settings);
  const amplitude = Math.abs(outline.amplitude);
  for (let r = 0; r < union.height; r += 1) {
    for (let c = 0; c < union.width; c += 1) {
      const at = r * union.width + c;
      const joined = union.values[at] ?? Number.POSITIVE_INFINITY;
      const coast = distance.values[at] ?? Number.POSITIVE_INFINITY;
      let offset = joined - reach;
      const weight =
        amplitude > 0
          ? smoothstep(start, start + Math.max(outline.ramp, 1e-6), coast)
          : 0;
      // Cells the noise cannot move across the rim or the escarpment keep the smooth offset.
      const near =
        offset > -amplitude - 1 && offset < settings.escarpment + amplitude + 1;
      if (weight > 0 && near) {
        const x = grid.left + (union.column + c + 0.5) * grid.cell;
        const y = grid.top + (union.row + r + 0.5) * grid.cell;
        offset += weight * displacement(x, y);
        offset = blendMax(offset, coast - reach - slack, grid.cell * 2);
      }
      outward[at] = offset;
    }
  }
  return outward;
}

/**
 * Map units past the bisector limit of one frame's platform at each cell
 * of its union: how much nearer than the escarpment's stepped width the
 * cell lies to the bisector with another frame's union, or `-Infinity`
 * where no other frame is near. Past the limit nothing of the frame, rim
 * or apron, stands above its escarpment there, so its platform reaches the
 * foot of its escarpment by the bisector and platforms of different frames
 * never meet.
 */
function bisectorOffsets(
  union: Crop,
  others: readonly Crop[],
  settings: PlatformSettings
): Float64Array {
  const offsets = new Float64Array(union.values.length).fill(
    Number.NEGATIVE_INFINITY
  );
  const stepped = settings.escarpment - escarpmentLayout(settings).foot;
  for (const other of others) {
    const left = Math.max(union.column, other.column);
    const top = Math.max(union.row, other.row);
    const right = Math.min(
      union.column + union.width,
      other.column + other.width
    );
    const bottom = Math.min(union.row + union.height, other.row + other.height);
    for (let row = top; row < bottom; row += 1) {
      for (let column = left; column < right; column += 1) {
        const local = (row - union.row) * union.width + column - union.column;
        const own = union.values[local] ?? Number.POSITIVE_INFINITY;
        const theirs =
          other.values[
            (row - other.row) * other.width + column - other.column
          ] ?? Number.POSITIVE_INFINITY;
        const bisector = stepped - (theirs - own) / 2;
        if (bisector > (offsets[local] ?? Number.NEGATIVE_INFINITY)) {
          offsets[local] = bisector;
        }
      }
    }
  }
  return offsets;
}

/** Map units from each cell inside the rim to the nearest cell past it; 0 past it. */
function rimDistance(
  outward: Float64Array,
  crop: Pick<Crop, "height" | "width">,
  cell: number
): Float32Array {
  const outside = new Uint8Array(outward.length);
  for (let at = 0; at < outward.length; at += 1) {
    outside[at] = (outward[at] ?? 0) > 0 ? 1 : 0;
  }
  const distances = shoreDistances(outside, crop.width, crop.height);
  for (let at = 0; at < distances.length; at += 1) {
    distances[at] = outside[at]
      ? 0
      : Math.max(0, (distances[at] ?? 0) - 0.5) * cell;
  }
  return distances;
}

/** One cell of a frame, as its floor is asked for. */
interface FrameCell {
  /** Map units to the frame's nearest coast. */
  coast: number;
  /** Map units inside the rim; 0 past it. */
  inward: number;
  /** Map units past the frame's bisector limit; `-Infinity` where no other frame is near. */
  limit: number;
  /** Map units past the rim; 0 or less inside it. */
  outward: number;
  x: number;
  y: number;
}

/**
 * An island's apron at one cell: its reach, fall and edge varied by noise,
 * and never above the escarpment past the frame's bisector limit;
 * `-Infinity` where every apron has plunged below any platform.
 */
function apronAt(
  cell: FrameCell,
  settings: PlatformSettings,
  fields: PlatformFields
): number {
  const { coast, x, y } = cell;
  if (coast >= apronLimit(settings)) {
    return Number.NEGATIVE_INFINITY;
  }
  const { edge, share } = settings.apronVariation;
  // The edge's noise fades in from the coast, so every coast keeps its foot.
  const moved =
    coast +
    edge.amplitude *
      smoothstep(0, settings.apronReach / 2, coast) *
      fields.apronEdge(x, y);
  const apron = apronFloor(Math.max(0, moved), settings, {
    fall: 1 + share * fields.apronFall(x, y),
    reach: 1 + share * fields.apronReach(x, y),
  });
  return cell.limit > 0
    ? Math.min(apron, escarpmentFloor(cell.limit, settings))
    : apron;
}

/**
 * Nominal metres of the platform's interior at one cell: its inner depth,
 * sunk into a basin the farther the cell lies past the aprons' reach, some
 * basins deeper than others.
 */
function interiorDepth(
  cell: FrameCell,
  settings: PlatformSettings,
  fields: PlatformFields
): number {
  const { basins, platformDepth } = settings;
  if (cell.outward > 0 || basins.depth <= 0) {
    return platformDepth.inner;
  }
  const sink = smoothstep(
    settings.apronReach,
    settings.apronReach + Math.max(basins.ramp, 1e-6),
    cell.coast
  );
  if (sink <= 0) {
    return platformDepth.inner;
  }
  const wave = fields.basins(cell.x, cell.y);
  return Math.max(
    platformDepth.inner,
    platformDepth.inner +
      basins.depth * sink * (1 - basins.share + basins.share * wave)
  );
}

/** The platform floor at one cell of a frame: its island's apron blended into the platform floor. */
function cellFloor(
  cell: FrameCell,
  settings: PlatformSettings,
  fields: PlatformFields
): number {
  const platform = platformFloor(
    {
      inner: interiorDepth(cell, settings, fields),
      inward: cell.inward,
      outward: cell.outward,
      ...(cell.outward > 0 && {
        risers: riserPlaces(fields, settings, cell.x, cell.y),
      }),
    },
    settings
  );
  return blendMax(apronAt(cell, settings, fields), platform, settings.blend);
}

/**
 * Map units past the rim of one frame's platform at each cell of its
 * union: past its own displaced rim, or past its bisector limit, whichever
 * is farther out.
 */
function rimOffsets(
  frame: { distance: Crop; union: Crop },
  grid: GeologyGrid,
  settings: PlatformSettings,
  fields: PlatformFields,
  limits: Float64Array
): Float64Array {
  const outward = outlineOffsets(frame, grid, settings, fields.outline);
  for (let at = 0; at < outward.length; at += 1) {
    outward[at] = Math.max(
      outward[at] ?? 0,
      limits[at] ?? Number.NEGATIVE_INFINITY
    );
  }
  return outward;
}

/**
 * Writes one frame's platform floor into `floor` where it is the highest
 * yet, and the frame's index into `frame` there where the floor stands
 * above the abyss.
 */
function placeFrame(
  target: { floor: Float32Array; frame: Int32Array; grid: GeologyGrid },
  frame: { distance: Crop; union: Crop },
  others: readonly Crop[],
  settings: PlatformSettings,
  noise: PlatformNoise,
  index: number
): void {
  const { distance, union } = frame;
  const { grid } = target;
  const fields = platformFields(union, grid, settings, noise);
  const limits = bisectorOffsets(union, others, settings);
  const outward = rimOffsets(frame, grid, settings, fields, limits);
  const inward = rimDistance(outward, union, grid.cell);
  for (let local = 0; local < outward.length; local += 1) {
    const offset = outward[local] ?? Number.POSITIVE_INFINITY;
    if (offset > settings.escarpment) {
      continue;
    }
    const c = local % union.width;
    const r = (local - c) / union.width;
    const at = (union.row + r) * grid.width + union.column + c;
    const value = cellFloor(
      {
        coast: distance.values[local] ?? Number.POSITIVE_INFINITY,
        inward: inward[local] ?? 0,
        limit: limits[local] ?? Number.NEGATIVE_INFINITY,
        outward: offset,
        x: grid.left + (union.column + c + 0.5) * grid.cell,
        y: grid.top + (union.row + r + 0.5) * grid.cell,
      },
      settings,
      fields
    );
    if (value > (target.floor[at] ?? Number.NEGATIVE_INFINITY)) {
      target.floor[at] = value;
      target.frame[at] = value > geologyLevels.abyss ? index : -1;
    }
  }
}

/**
 * The share, 0 to 1, of the structural column from the abyss to `shelfTop`
 * that a cell's shelves and basements fill, composed as the structural
 * terrain composes them but without the coast's own descent.
 */
function structureShare(
  surface: TerrainSurface,
  terrain: StructuralTerrain,
  at: number
): number {
  const { abyss, basementTop, shelfTop } = terrainLevels;
  const basement = surface.basement[at] ?? 0;
  const shelf = surface.shelf[at] ?? 0;
  const base =
    abyss +
    (basementTop - abyss) *
      (basement > 0
        ? basement / (basement + terrain.settings.basementHalf)
        : 0);
  const structure =
    base +
    (shelfTop - base) *
      (shelf > 0 ? shelf / (shelf + terrain.settings.shelfHalf) : 0);
  return (structure - abyss) / (shelfTop - abyss);
}

/**
 * The largest 32-bit float at or below `value`: a cap a stored cell can meet
 * exactly, since rounding to 32 bits could otherwise lift it past the cap.
 */
function float32AtOrBelow(value: number): number {
  const rounded = Math.fround(value);
  if (rounded <= value) {
    return rounded;
  }
  const bits = new Float32Array([rounded]);
  const word = new Int32Array(bits.buffer);
  // Negative floats grow in magnitude, and so fall, as their bits grow.
  word[0] = (word[0] ?? 0) + (rounded < 0 ? 1 : -1);
  return bits[0] ?? value;
}

/** Islands grouped by frame, groups sorted and islands by id within each. */
function groupIslands(islands: readonly PlatformIsland[]) {
  const groups = new Map<string, PlatformIsland[]>();
  for (const island of [...islands].sort((a, b) => a.id.localeCompare(b.id))) {
    const members = groups.get(island.group) ?? [];
    members.push(island);
    groups.set(island.group, members);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

function buildPlatform(
  input: PlatformInput,
  settings: PlatformSettings,
  key: string
): ArchipelagoPlatform {
  const { terrain } = input;
  const surface = input.surface ?? terrain.surface;
  const grid: GeologyGrid = terrain;
  const size = grid.width * grid.height;
  const floor = new Float32Array(size).fill(Number.NEGATIVE_INFINITY);
  const frame = new Int32Array(size).fill(-1);
  const grouped = groupIslands(input.islands);
  const limit =
    platformLimit(settings) +
    settings.join +
    Math.max(0, Math.abs(settings.outline.amplitude));
  const noise = platformNoise(settings);
  const frames = grouped.map(([, members]) => {
    const distance = frameDistance(members, grid, limit);
    return (
      distance && {
        distance,
        union: joinedDistance(distance, settings.join, grid.cell),
      }
    );
  });
  for (const [index, item] of frames.entries()) {
    if (item) {
      placeFrame(
        { floor, frame, grid },
        item,
        frames.flatMap((other, at) =>
          other && at !== index ? [other.union] : []
        ),
        settings,
        noise,
        index
      );
    }
  }
  const cap = float32AtOrBelow(elevationAtDepth(settings.apronDepth.coast));
  const structureTop = elevationAtDepth(settings.apronDepth.edge);
  const seabed = Float32Array.from(surface.elevation);
  for (let at = 0; at < size; at += 1) {
    const under = floor[at] ?? Number.NEGATIVE_INFINITY;
    if ((terrain.signedDistance[at] ?? 0) < 0 || (frame[at] ?? -1) < 0) {
      continue;
    }
    const base = surface.elevation[at] ?? geologyLevels.abyss;
    const raised =
      under +
      Math.max(0, structureTop - under) *
        settings.structure *
        structureShare(surface, terrain, at);
    seabed[at] = Math.min(
      smoothMax(base, raised, settings.smoothing),
      Math.max(base, cap)
    );
  }
  return {
    frame,
    groups: grouped.map(([group]) => group),
    key,
    seabed,
  };
}

/** FNV-1a over a string, continuing from `hash`. */
function hashText(text: string, hash = 2_166_136_261): number {
  let h = hash;
  for (let index = 0; index < text.length; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: A deterministic 32-bit hash identifies a cached platform.
    h = Math.imul(h ^ text.charCodeAt(index), 16_777_619) >>> 0;
  }
  return h;
}

/** FNV-1a over a float field's bits, continuing from `hash`. */
function hashValues(values: Float32Array, hash = 2_166_136_261): number {
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
  let h = hash;
  for (const word of bits) {
    // biome-ignore lint/suspicious/noBitwiseOperators: A deterministic 32-bit hash identifies a cached platform.
    h = Math.imul(h ^ word, 16_777_619) >>> 0;
  }
  return h;
}

/** Content identity for the platform cache, never a security hash. */
function platformKey(input: PlatformInput, settings: PlatformSettings): string {
  const { terrain } = input;
  const surface =
    !input.surface || input.surface === terrain.surface
      ? "surface"
      : hashValues(input.surface.elevation).toString(16);
  const islands = [...input.islands]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((island) => [
      island.id,
      island.group,
      island.x,
      island.y,
      island.coast,
    ]);
  const json = JSON.stringify([terrain.key, surface, settings, islands]);
  return `platform:${terrain.key}/${hashText(json).toString(16)}`;
}

/** Most recent platforms kept by content. */
const cacheEntries = 4;
const cache = new Map<string, ArchipelagoPlatform>();

/**
 * The archipelago platforms under a structural terrain's islands, one per
 * frame, and the seabed raised to them; built once per content and reused
 * while it is unchanged.
 */
export function archipelagoPlatform(input: PlatformInput): ArchipelagoPlatform {
  const settings = input.settings ?? defaultPlatformSettings;
  const key = platformKey(input, settings);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const platform = buildPlatform(input, settings, key);
  cache.set(key, platform);
  while (cache.size > cacheEntries) {
    const [oldest] = cache.keys();
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
  return platform;
}
