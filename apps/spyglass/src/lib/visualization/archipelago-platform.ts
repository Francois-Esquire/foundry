import { shoreDistances } from "./distance-field";
import { elevationAtDepth, type GeologyGrid, geologyLevels } from "./geology";
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
 * The platform's extent is a smooth union of its islands: every cell
 * within `reach` of the frame's coasts, measured on the coast distance
 * blurred by `join`, so near neighbours share one platform without a waist
 * between them. Its depth follows its rim, not its islands: shallowest in
 * the interior and deepening toward the rim over `tilt`, so terraces run
 * parallel to the rim as stacked plates. Past the rim an escarpment falls
 * to the deep in benches. Each island keeps a pale apron at its
 * foot, which falls to the platform. Each frame has its own platform, and
 * platforms of different frames never join.
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
  /** Map units over which the rim falls from the platform's outer depth to the deep. */
  escarpment: number;
  /**
   * The escarpment's steps: how many risers it falls in, each followed by a
   * flat bench, and the share of a step its riser takes.
   */
  escarpmentSteps: { count: number; riser: number };
  /**
   * Map units across the blur that joins the islands: the distance crest
   * between two neighbours is lowered by about a third of it, and the rim
   * is rounded.
   */
  join: number;
  /** Nominal metres of water over the platform: in its interior, and at its rim. */
  platformDepth: { inner: number; outer: number };
  /** Map units past the joined coast distance to the platform's rim, where the escarpment begins. */
  reach: number;
  /** Smooth-maximum width, in elevation units, where the platform meets the structural seabed. */
  smoothing: number;
  /** Share, 0 to 1, of the structural column that shelves and basements fill again above the platform. */
  structure: number;
  /** Map units inward from the rim over which the platform rises from its outer to its inner depth. */
  tilt: number;
}

export const defaultPlatformSettings: PlatformSettings = {
  apronDepth: { coast: 5, edge: 18 },
  apronFall: 16,
  apronReach: 30,
  escarpment: 84,
  escarpmentSteps: { count: 3, riser: 0.4 },
  join: 48,
  platformDepth: { inner: 30, outer: 85 },
  reach: 88,
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

/**
 * An island's apron at a distance past the nearest coast of its frame: from its coast
 * depth to its edge depth over `apronReach`, then down to the platform's
 * outer depth over `apronFall`. Beyond that the apron is gone.
 */
export function apronFloor(
  distance: number,
  settings: PlatformSettings = defaultPlatformSettings
): number {
  const { apronDepth, apronFall, apronReach, platformDepth } = settings;
  if (distance <= apronReach) {
    return depthBetween(
      apronDepth.coast,
      apronDepth.edge,
      Math.max(0, distance) / Math.max(apronReach, 1e-6)
    );
  }
  if (distance <= apronReach + apronFall) {
    return depthBetween(
      apronDepth.edge,
      platformDepth.outer,
      smoothstep(apronReach, apronReach + apronFall, distance)
    );
  }
  return Number.NEGATIVE_INFINITY;
}

/**
 * The escarpment's fall, 0 at the rim to 1 at its foot, over a share `t` of
 * its width: `count` steps, each a smooth riser over the first `riser` of
 * the step and then a flat bench.
 */
function escarpmentFall(
  t: number,
  steps: PlatformSettings["escarpmentSteps"]
): number {
  const count = Math.max(1, Math.round(steps.count));
  const s = Math.min(1, Math.max(0, t)) * count;
  const step = Math.min(count - 1, Math.floor(s));
  return (step + smoothstep(0, Math.max(steps.riser, 1e-6), s - step)) / count;
}

/**
 * The platform floor's elevation from a cell's place on it: `inward` map
 * units inside the rim, or `outward` past it. Inside, the platform rises
 * from its outer depth at the rim to its inner depth `tilt` inward. Past
 * the rim the escarpment falls in benches to the trench floor, more than
 * any smoothing width below the abyss, so the open abyss is left exactly
 * as it was.
 */
export function platformFloor(
  place: { inward: number; outward: number },
  settings: PlatformSettings = defaultPlatformSettings
): number {
  const { platformDepth } = settings;
  if (place.outward <= 0) {
    return depthBetween(
      platformDepth.outer,
      platformDepth.inner,
      smoothstep(0, Math.max(settings.tilt, 1e-6), place.inward)
    );
  }
  const rim = elevationAtDepth(platformDepth.outer);
  return (
    rim +
    (geologyLevels.trenchFloor - rim) *
      escarpmentFall(
        place.outward / Math.max(settings.escarpment, 1e-6),
        settings.escarpmentSteps
      )
  );
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

/**
 * Map units past the rim of one frame's platform at each cell of its
 * union: past the union's `reach`, or nearer than `escarpment` to the
 * bisector with another frame's union, whichever is farther out. A frame's
 * platform therefore reaches the foot of its escarpment by the bisector,
 * and platforms of different frames never meet.
 */
function rimOffsets(
  union: Crop,
  others: readonly Crop[],
  settings: PlatformSettings
): Float64Array {
  const outward = Float64Array.from(
    union.values,
    (distance) => distance - settings.reach
  );
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
        const bisector = settings.escarpment - (theirs - own) / 2;
        if (bisector > (outward[local] ?? 0)) {
          outward[local] = bisector;
        }
      }
    }
  }
  return outward;
}

/** Map units from each cell inside the rim to the nearest cell past it; 0 past it. */
function rimDistance(
  outward: Float64Array,
  crop: Pick<Crop, "height" | "width">,
  cell: number
): Float32Array {
  const outside = Uint8Array.from(outward, (offset) => (offset > 0 ? 1 : 0));
  const distances = shoreDistances(outside, crop.width, crop.height);
  return Float32Array.from(distances, (cells, at) =>
    outside[at] ? 0 : Math.max(0, cells - 0.5) * cell
  );
}

/**
 * Writes one frame's platform floor into `floor` where it is the highest
 * yet, and the frame's index into `frame` there where the floor stands
 * above the abyss.
 */
function placeFrame(
  target: { floor: Float32Array; frame: Int32Array; width: number },
  frame: { distance: Crop; union: Crop },
  others: readonly Crop[],
  settings: PlatformSettings,
  cell: number,
  index: number
): void {
  const { distance, union } = frame;
  const outward = rimOffsets(union, others, settings);
  const inward = rimDistance(outward, union, cell);
  for (let r = 0; r < union.height; r += 1) {
    for (let c = 0; c < union.width; c += 1) {
      const local = r * union.width + c;
      const offset = outward[local] ?? Number.POSITIVE_INFINITY;
      if (offset > settings.escarpment) {
        continue;
      }
      const at = (union.row + r) * target.width + union.column + c;
      const value = Math.max(
        apronFloor(
          distance.values[local] ?? Number.POSITIVE_INFINITY,
          settings
        ),
        platformFloor({ inward: inward[local] ?? 0, outward: offset }, settings)
      );
      if (value > (target.floor[at] ?? Number.NEGATIVE_INFINITY)) {
        target.floor[at] = value;
        target.frame[at] = value > geologyLevels.abyss ? index : -1;
      }
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
  const limit = platformLimit(settings) + settings.join;
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
        { floor, frame, width: grid.width },
        item,
        frames.flatMap((other, at) =>
          other && at !== index ? [other.union] : []
        ),
        settings,
        grid.cell,
        index
      );
    }
  }
  const cap = elevationAtDepth(settings.apronDepth.coast);
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
