import {
  elevationAtDepth,
  type GeologyGrid,
  geologyLevels,
  gradientGrid,
  type SeabedContribution,
  sampleGrid,
  seabedCeiling,
} from "./geology";
import { fbm, gradientNoise, latticeHash, noiseSeed } from "./noise";
import { fillPolygon } from "./scanline-fill";
import type { TerrainContributionSource } from "./terrain";
import type { Polygon } from "./types";

/**
 * Named features of the seabed between and around the islands, refining the
 * structural terrain without re-adding its shelves. Each feature comes from a
 * relationship in the data or from the terrain's own shape:
 *
 * - A ridge joins two neighbouring islands that are related, by a route or a
 *   shared shelf. Its crest follows the shallowest crossing between them and
 *   stands in the shelf band, a spine on broad shoulders raised over the
 *   platform's basins, so related islands' banks merge along it.
 * - A channel carves the strait between two neighbouring islands with no
 *   relationship at all, along the line midway between their coasts: a
 *   sinuous trough into the slope band, deepest at the narrows and widening
 *   and narrowing as it runs.
 * - A seamount is a submerged peak at a positioned thing with no island: a
 *   former package, drowned where its wreck is drawn, a flat-topped guyot
 *   on broad, lobed flanks the terrace pass steps. On a seabed already
 *   shallower than its nominal crest it still rises a little over it.
 * - A trench carves the seam between two archipelagos, along the line midway
 *   between their nearest coasts.
 * - A canyon cuts down the platform's rim from a head where an island stands
 *   nearest the edge, following the escarpment's fall; a spur stands
 *   between canyons, a rib raised down the same fall. Both are few, so the
 *   escarpment keeps its benches.
 *
 * Every line feature meanders by seeded noise, its ends held, so none is a
 * straight stroke.
 *
 * Every cross-section is a smooth profile, so a fine-detail pass can be laid
 * over it. Each feature raises the seabed toward its crest, or carves it
 * toward its floor, never past it: a contribution is a blend toward a target
 * elevation, not a fixed bump. Features are applied in order on a working
 * copy of the seabed, so where two overlap, the later one only makes up what
 * the earlier left, and their sum still stops at the deeper target. Every
 * contribution is 0 on land.
 */
export const defaultSeafloorSettings = {
  canyon: {
    cap: 4,
    /** Nominal metres the trace stops at: the escarpment's foot. */
    end: 1900,
    /** Nominal metres between which a head may stand: the rim's first riser and bench. */
    head: { deep: 250, shallow: 100 },
    /** Map units the head cuts back up into the platform, past the rim. */
    headReach: 20,
    /** Elevation the floor lies below the slope it cuts, at full depth. */
    incision: 0.09,
    /** Map units of the meander's displacement and of its wavelength. */
    meander: { amplitude: 6, wavelength: 40 },
    /**
     * Map units a head stands at least from the nearest coast: past every
     * island's own slope, so falls head from a platform's rim and never
     * from an island's flank.
     */
    offshore: 70,
    /** Map units at least between any two heads, canyon or spur. */
    spacing: 150,
    taper: 0.15,
    width: 6,
  },
  channel: {
    asymmetry: 0.2,
    /** 0 to 1: the share by which the trough widens and narrows along its length. */
    breadth: 0.35,
    cap: 4,
    /**
     * Nominal metres of the floor at the narrows: nearest and farthest
     * unrelated pairs. Both are in the slope band, under the platform's
     * basins, so a channel reads as a trough between them; toward its ends
     * the floor shoals to `shoal` of that depth.
     */
    depth: { far: 300, near: 400 },
    /** Map units beyond the narrows along which the channel runs. */
    extent: 140,
    /** Coasts farther apart than this are already apart; no channel. */
    maxGap: 140,
    /**
     * The meander: map units of displacement, at most `share` of the gap so
     * the trough keeps clear of both coasts, and of its wavelength.
     */
    meander: { amplitude: 14, share: 0.15, wavelength: 56 },
    /** The trough's width as a share of the gap, at most `width`. */
    share: 1 / 6,
    /** Share of the narrows' depth the floor shoals to at the channel's ends. */
    shoal: 0.5,
    taper: 0.3,
    width: 12,
  },
  /** 0 to 1: how far every feature goes toward its target. */
  intensity: 1,
  /** A feature whose greatest change to the seabed is less than this is left out. */
  minRelief: 0.02,
  ridge: {
    /** 0 to 1: how much wider the flank facing deeper water is. */
    asymmetry: 0.25,
    /** The most ridges on the chart. */
    cap: 12,
    /**
     * Nominal metres over the saddle: strongest and weakest relationship.
     * Both are in the shelf band, 20 to 100 m, either side of the 40 m
     * level, under the shelves and shallower than the platform's basins, so
     * a ridge reads as a spine across them; on a shallower seabed it has
     * nothing to raise and is left out.
     */
    depth: { strong: 30, weak: 55 },
    /** Cost of crossing water, per unit of depth, when the crest is routed. */
    depthCost: 4,
    /** Coasts farther apart than this, in map units, are not joined. */
    maxGap: 200,
    /** Map units of the crest's meander and of its wavelength. */
    meander: { amplitude: 5, wavelength: 44 },
    /** Route weight, both directions summed, that alone makes a ridge. */
    minRoute: 8,
    /** How far the crest rises from the saddle toward each island. */
    rise: 0.12,
    /** Route weight at which a ridge is half its full strength. */
    routeHalf: 24,
    /** Shared shelf weight at which a ridge is half its full strength. */
    shelfHalf: 3,
    /**
     * The broad shoulders the spine stands on: the share, 0 to 1, of the
     * way to the crest they rise, and map units to their 0.61 point.
     */
    shoulder: { share: 0.55, width: 28 },
    /** Share of the path at each end over which the crest fades in. */
    taper: 0.08,
    /** The crest's rise and fall along its length: elevation, and map units of wavelength. */
    undulation: { amplitude: 0.035, wavelength: 48 },
    /** Map units from the crest to the flank's 0.61 point. */
    width: 14,
  },
  seamount: {
    asymmetry: 0.3,
    cap: 6,
    /**
     * Nominal metres over the summit at full strength: in the slope band,
     * on the 100 to 250 m tread, so the guyot's top shows through the
     * water and its flanks cross every deeper level.
     */
    depth: 175,
    /**
     * The flanks' lobes: the share, 0 to 1, by which angular noise moves the
     * flank in and out round the summit, so no seamount is a perfect cone.
     */
    lobes: 0.22,
    /** Map units of flat top: a drowned island is a guyot. */
    plateau: 12,
    /**
     * Elevation the summit stands at least above the seabed under it, at full
     * strength, so a drowned island on a shallow platform is still a knoll.
     */
    rise: 0.12,
    /** Map units to the flank's 0.61 point: broad enough that the terrace pass steps it. */
    width: 30,
  },
  /** Seeds every meander and undulation. */
  seed: "spyglass:seafloor",
  /** Smooth-maximum width, in elevation, where a feature meets the seabed. */
  smoothing: 0.02,
  spur: {
    cap: 3,
    /** Map units of the meander's displacement and of its wavelength. */
    meander: { amplitude: 4, wavelength: 40 },
    /** Elevation the rib stands above the slope it runs down, at full height. */
    rise: 0.05,
    taper: 0.15,
    width: 8,
  },
  trench: {
    asymmetry: 0.4,
    cap: 2,
    /** Nominal metres of the floor: nearest and farthest archipelagos, below the abyss at 2,000 m. */
    depth: { far: 2650, near: 3350 },
    extent: 220,
    maxGap: 700,
    share: 1 / 5,
    taper: 0.25,
    width: 28,
  },
};
export type SeafloorSettings = typeof defaultSeafloorSettings;

type SeafloorFeatureKind =
  | "canyon"
  | "channel"
  | "ridge"
  | "seamount"
  | "spur"
  | "trench";

type SeafloorGeometry =
  | { points: readonly [number, number][]; type: "polyline" }
  | { point: readonly [number, number]; type: "point" };

/** One named feature of the seabed, with the identity it keeps for labels and selection. */
interface SeafloorFeature {
  /** The crest's elevation for a raise, the floor's for a carve, in `geologyLevels` units. */
  elevation: number;
  geometry: SeafloorGeometry;
  /** `<kind>:<members joined by +>`, stable for one input. */
  id: string;
  kind: SeafloorFeatureKind;
  label?: string;
  /** Island ids, archipelago ids, or the id of the thing a seamount stands for. */
  members: readonly string[];
  /** 0 to 1: how strongly the data asks for it. */
  strength: number;
}

export interface SeafloorIsland {
  /** Island-local, offset by `x` and `y`, as the structural terrain's. */
  coast: readonly Polygon[];
  /** The archipelago it belongs to; islands of different groups are set apart by trenches. */
  group?: string;
  id: string;
  label?: string;
  radius: number;
  x: number;
  y: number;
}

/** A relationship between two islands, as a route's weight. */
export interface SeafloorLink {
  from: string;
  to: string;
  weight: number;
}

/** Something positioned on the chart that has no island of its own. */
export interface SeafloorSummit {
  id: string;
  label?: string;
  members: readonly string[];
  /** 0 to 1; 1 when absent. */
  strength?: number;
  x: number;
  y: number;
}

/** The structural terrain, as far as the seabed's features read it. */
export interface SeafloorTerrain extends GeologyGrid {
  contributions: readonly { source: TerrainContributionSource }[];
  /** Map units to the nearest coast, negative on land. */
  signedDistance: ArrayLike<number>;
  surface: { elevation: ArrayLike<number> };
}

export interface SeafloorInput {
  islands: readonly SeafloorIsland[];
  links: readonly SeafloorLink[];
  summits: readonly SeafloorSummit[];
  terrain: SeafloorTerrain;
}

export interface Seafloor {
  /** One per feature, with the feature's id, on the terrain's grid. */
  contributions: SeabedContribution[];
  features: SeafloorFeature[];
}

type Point = [number, number];

/** A profile value below this is no influence: it bounds each crop. */
const negligible = 0.002;
/** Gaussian reach, in widths, at which a profile becomes negligible. */
const reachWidths = Math.sqrt(2 * Math.log(1 / negligible));

/** A feature's cross-section: its width, the flank asymmetry, a flat top, and broad shoulders. */
export interface CrossSection {
  /** 0 to 1: the positive side is this much wider, the negative this much narrower. */
  asymmetry: number;
  /** Map units held at full influence about the axis. */
  plateau?: number;
  /** A broader, weaker Gaussian the core stands on: its peak influence, 0 to 1, and its width. */
  shoulder?: { share: number; width: number };
  width: number;
}

/**
 * Influence, 0 to 1, at a signed offset from a feature's axis: 1 within the
 * plateau, then a Gaussian flank whose width differs by side, standing on
 * the shoulder where it has one. It is smooth everywhere but where flank
 * and shoulder meet, its slope 0 on the axis.
 */
export function crossSection(offset: number, profile: CrossSection): number {
  const side = offset >= 0 ? 1 + profile.asymmetry : 1 - profile.asymmetry;
  const beyond = Math.max(0, Math.abs(offset) - (profile.plateau ?? 0));
  const width = Math.max(1e-6, profile.width * side);
  const core = Math.exp(-0.5 * (beyond / width) ** 2);
  const { shoulder } = profile;
  if (!shoulder || shoulder.share <= 0) {
    return core;
  }
  const broad = Math.max(1e-6, shoulder.width * side);
  return Math.max(
    core,
    Math.min(1, shoulder.share) * Math.exp(-0.5 * (beyond / broad) ** 2)
  );
}

/** Map units from the axis at which a cross-section becomes negligible. */
function crossSectionReach(profile: CrossSection): number {
  const widest = Math.max(
    profile.width,
    profile.shoulder && profile.shoulder.share > 0 ? profile.shoulder.width : 0
  );
  return (
    (profile.plateau ?? 0) +
    widest * (1 + Math.abs(profile.asymmetry)) * reachWidths
  );
}

/** `max(x, 0)`, rounded over `[-k, k]` so it is smooth; never below the true maximum. */
export function smoothPositive(x: number, k: number): number {
  if (x >= k) {
    return x;
  }
  if (x <= -k || k <= 0) {
    return Math.max(0, x);
  }
  return (x + k) ** 2 / (4 * k);
}

/** 0 at `low`, 1 at `high`, smooth between; `low` must be below `high`. */
function smoothstep(low: number, high: number, value: number): number {
  if (high <= low) {
    throw new Error("A smoothstep's low edge must be below its high edge.");
  }
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** Targets stay inside the band the contract allows, with room for smoothing. */
function boundedTarget(elevation: number, smoothing: number): number {
  return Math.min(
    seabedCeiling - smoothing,
    Math.max(geologyLevels.trenchFloor, elevation)
  );
}

/** The canonical id of an unordered pair. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}+${b}` : `${b}+${a}`;
}

/** A sea cell on each side of a boundary between two regions. */
interface SeamPoint {
  /** Map units from the boundary to the nearest coast. */
  distance: number;
  x: number;
  y: number;
}

/** Two regions that meet, and how closely their coasts approach. */
interface Neighbours {
  a: number;
  b: number;
  /** The narrowest crossing between their coasts, in map units. */
  gap: number;
  points: SeamPoint[];
}

/** Every cell's nearest island and its distance from that island's coast. */
interface CoastField {
  /** Map units to the nearest coast; 0 on land. */
  distance: Float32Array;
  grid: GeologyGrid;
  /** Whether a cell is land, by the islands' own coasts. */
  land: Uint8Array;
  /** The index of the nearest island, or of the island a land cell is. */
  nearest: Int32Array;
}

function fallbackCoast(radius: number): Polygon[] {
  const ring: Point[] = Array.from({ length: 32 }, (_, i) => [
    Math.cos((i * Math.PI) / 16) * radius,
    Math.sin((i * Math.PI) / 16) * radius,
  ]);
  return [[ring]];
}

/** Rasterises each island's coast on the grid, as the structural terrain does. */
function islandOwners(
  grid: GeologyGrid,
  islands: readonly SeafloorIsland[]
): Int32Array {
  const owner = new Int32Array(grid.width * grid.height).fill(-1);
  for (const [index, island] of islands.entries()) {
    const coast = island.coast.length
      ? island.coast
      : fallbackCoast(Math.max(1, island.radius));
    const rings = coast.map((polygon) =>
      polygon.map((ring) =>
        ring.map(
          ([x, y]): Point => [
            (island.x + x - grid.left) / grid.cell,
            (island.y + y - grid.top) / grid.cell,
          ]
        )
      )
    );
    const points = rings.flat(2);
    const column = Math.max(0, Math.floor(Math.min(...points.map(([x]) => x))));
    const row = Math.max(0, Math.floor(Math.min(...points.map(([, y]) => y))));
    const right = Math.min(
      grid.width,
      Math.ceil(Math.max(...points.map(([x]) => x))) + 1
    );
    const bottom = Math.min(
      grid.height,
      Math.ceil(Math.max(...points.map(([, y]) => y))) + 1
    );
    const width = right - column;
    const height = bottom - row;
    if (width <= 0 || height <= 0) {
      continue;
    }
    const mask = new Uint8Array(width * height);
    for (const polygon of rings) {
      fillPolygon(
        mask,
        width,
        height,
        polygon.map((ring) =>
          ring.map(([x, y]): Point => [x - column, y - row])
        )
      );
    }
    for (let r = 0; r < height; r += 1) {
      for (let c = 0; c < width; c += 1) {
        if (mask[r * width + c]) {
          owner[(row + r) * grid.width + column + c] = index;
        }
      }
    }
  }
  return owner;
}

const forward: readonly Point[] = [
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];
const backward: readonly Point[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
];

/** One sweep of nearest-coast propagation over the grid, in one direction. */
function sweep(
  grid: GeologyGrid,
  seed: Int32Array,
  squared: Float64Array,
  offsets: readonly Point[],
  reverse: boolean
): void {
  const { height, width } = grid;
  const size = width * height;
  for (let step = 0; step < size; step += 1) {
    const index = reverse ? size - 1 - step : step;
    const column = index % width;
    const row = (index - column) / width;
    for (const [dc, dr] of offsets) {
      const c = column + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= width || r >= height) {
        continue;
      }
      const candidate = seed[r * width + c] ?? -1;
      if (candidate < 0) {
        continue;
      }
      const sc = candidate % width;
      const sr = (candidate - sc) / width;
      const d = (sc - column) ** 2 + (sr - row) ** 2;
      if (d < (squared[index] ?? Number.POSITIVE_INFINITY)) {
        squared[index] = d;
        seed[index] = candidate;
      }
    }
  }
}

/**
 * Each cell's nearest island, by propagating the nearest coast cell over the
 * grid in two sweeps: a close approximation of the exact distance, everywhere
 * on the grid, where the structural terrain's own distance stops at its reach.
 */
function coastField(
  grid: GeologyGrid,
  islands: readonly SeafloorIsland[],
  signedDistance: ArrayLike<number>
): CoastField {
  const { height, width } = grid;
  const size = width * height;
  const owner = islandOwners(grid, islands);
  const land = new Uint8Array(size);
  const seed = new Int32Array(size).fill(-1);
  const squared = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  for (let index = 0; index < size; index += 1) {
    const isLand =
      (owner[index] ?? -1) >= 0 ||
      (signedDistance[index] ?? Number.POSITIVE_INFINITY) < 0;
    land[index] = isLand ? 1 : 0;
    if ((owner[index] ?? -1) >= 0) {
      seed[index] = index;
      squared[index] = 0;
    }
  }
  sweep(grid, seed, squared, forward, false);
  sweep(grid, seed, squared, backward, true);
  const nearest = Int32Array.from(seed, (cell) =>
    cell >= 0 ? (owner[cell] ?? -1) : -1
  );
  // A seed is a land cell's centre, half a cell inside its coast.
  const distance = Float32Array.from(squared, (d, index) =>
    land[index] ? 0 : Math.max(0, Math.sqrt(d) - 0.5) * grid.cell
  );
  return { distance, grid, land, nearest };
}

function centre(grid: GeologyGrid, index: number): Point {
  const column = index % grid.width;
  const row = (index - column) / grid.width;
  return [
    grid.left + (column + 0.5) * grid.cell,
    grid.top + (row + 0.5) * grid.cell,
  ];
}

/**
 * Regions that meet across a cell edge, by a region index per cell, with the
 * points of their boundary and the narrowest crossing between their coasts.
 */
function neighbours(
  field: CoastField,
  region: (index: number) => number
): Map<string, Neighbours> {
  const { grid } = field;
  const found = new Map<string, Neighbours>();
  const visit = (i: number, j: number) => {
    const a = region(i);
    const b = region(j);
    if (a < 0 || b < 0 || a === b || field.land[i] || field.land[j]) {
      return;
    }
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const di = field.distance[i] ?? 0;
    const dj = field.distance[j] ?? 0;
    const [xi, yi] = centre(grid, i);
    const [xj, yj] = centre(grid, j);
    const entry = found.get(key) ?? {
      a: Math.min(a, b),
      b: Math.max(a, b),
      gap: Number.POSITIVE_INFINITY,
      points: [],
    };
    entry.gap = Math.min(entry.gap, di + dj + grid.cell);
    entry.points.push({
      distance: (di + dj) / 2,
      x: (xi + xj) / 2,
      y: (yi + yj) / 2,
    });
    found.set(key, entry);
  };
  for (let row = 0; row < grid.height; row += 1) {
    for (let column = 0; column < grid.width; column += 1) {
      const index = row * grid.width + column;
      if (column + 1 < grid.width) {
        visit(index, index + 1);
      }
      if (row + 1 < grid.height) {
        visit(index, index + grid.width);
      }
    }
  }
  return found;
}

/** A binary min-heap of cell indices by cost. */
class CellHeap {
  private readonly cells: number[] = [];
  private readonly costs: number[] = [];

  get size(): number {
    return this.cells.length;
  }

  push(cell: number, cost: number): void {
    this.cells.push(cell);
    this.costs.push(cost);
    let i = this.cells.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if ((this.costs[parent] ?? 0) <= cost) {
        break;
      }
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.cells[0] ?? -1;
    const last = this.cells.length - 1;
    this.swap(0, last);
    this.cells.pop();
    this.costs.pop();
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let least = i;
      if (
        left < this.cells.length &&
        (this.costs[left] ?? 0) < (this.costs[least] ?? 0)
      ) {
        least = left;
      }
      if (
        right < this.cells.length &&
        (this.costs[right] ?? 0) < (this.costs[least] ?? 0)
      ) {
        least = right;
      }
      if (least === i) {
        return top;
      }
      this.swap(i, least);
      i = least;
    }
  }

  private swap(i: number, j: number): void {
    const cell = this.cells[i] ?? 0;
    const cost = this.costs[i] ?? 0;
    this.cells[i] = this.cells[j] ?? 0;
    this.costs[i] = this.costs[j] ?? 0;
    this.cells[j] = cell;
    this.costs[j] = cost;
  }
}

const steps: readonly [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/**
 * The shallowest crossing from one island's coast to another's, through
 * sea cells nearer to one of them than to any other island: each step costs
 * its length, more the deeper the water under it. With shelves it follows
 * them; without, it takes the narrows.
 */
function shallowestPath(
  field: CoastField,
  elevation: ArrayLike<number>,
  from: number,
  to: number,
  depthCost: number
): Point[] {
  const { grid } = field;
  const size = grid.width * grid.height;
  const search: PathSearch = {
    cost: new Float64Array(size).fill(Number.POSITIVE_INFINITY),
    depthCost,
    elevation,
    field,
    heap: new CellHeap(),
    previous: new Int32Array(size).fill(-1),
    within: (index) => {
      const owner = field.nearest[index];
      return !field.land[index] && (owner === from || owner === to);
    },
  };
  for (let index = 0; index < size; index += 1) {
    if (coastal(field, index, from)) {
      search.cost[index] = 0;
      search.heap.push(index, 0);
    }
  }
  while (search.heap.size) {
    const index = search.heap.pop();
    if (coastal(field, index, to)) {
      return tracePath(grid, search.previous, index);
    }
    relax(search, index);
  }
  return [];
}

/** A shortest-path search over the grid, in progress. */
interface PathSearch {
  cost: Float64Array;
  depthCost: number;
  elevation: ArrayLike<number>;
  field: CoastField;
  heap: CellHeap;
  previous: Int32Array;
  within: (index: number) => boolean;
}

/** Whether a sea cell lies against an island's coast. */
function coastal(field: CoastField, index: number, island: number): boolean {
  return (
    !field.land[index] &&
    field.nearest[index] === island &&
    (field.distance[index] ?? Number.POSITIVE_INFINITY) <= field.grid.cell * 1.5
  );
}

/** Offers each neighbour of a settled cell a cheaper route through it. */
function relax(search: PathSearch, index: number): void {
  const { grid } = search.field;
  const here = search.cost[index] ?? 0;
  const column = index % grid.width;
  const row = (index - column) / grid.width;
  for (const [dc, dr, length] of steps) {
    const c = column + dc;
    const r = row + dr;
    if (c < 0 || r < 0 || c >= grid.width || r >= grid.height) {
      continue;
    }
    const next = r * grid.width + c;
    if (!search.within(next)) {
      continue;
    }
    const depth = Math.max(0, -(search.elevation[next] ?? geologyLevels.abyss));
    const total = here + length * (1 + search.depthCost * depth);
    if (total < (search.cost[next] ?? Number.POSITIVE_INFINITY)) {
      search.cost[next] = total;
      search.previous[next] = index;
      search.heap.push(next, total);
    }
  }
}

function tracePath(grid: GeologyGrid, previous: Int32Array, end: number) {
  const path: Point[] = [];
  for (let index = end; index >= 0; index = previous[index] ?? -1) {
    path.push(centre(grid, index));
  }
  return path.reverse();
}

/** A moving average over `window` points each side, `passes` times, its ends held. */
function smoothPolyline(points: readonly Point[], window: number, passes = 3) {
  let current = [...points];
  for (let pass = 0; pass < passes; pass += 1) {
    current = current.map((point, index): Point => {
      if (index === 0 || index === current.length - 1) {
        return point;
      }
      const reach = Math.min(window, index, current.length - 1 - index);
      let x = 0;
      let y = 0;
      for (let k = -reach; k <= reach; k += 1) {
        const [px = 0, py = 0] = current[index + k] ?? point;
        x += px;
        y += py;
      }
      return [x / (2 * reach + 1), y / (2 * reach + 1)];
    });
  }
  return current;
}

function polylineLength(points: readonly Point[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const [ax = 0, ay = 0] = points[index - 1] ?? [];
    const [bx = 0, by = 0] = points[index] ?? [];
    length += Math.hypot(bx - ax, by - ay);
  }
  return length;
}

/** Points evenly `spacing` apart along a polyline, its ends kept. */
function resample(points: readonly Point[], spacing: number): Point[] {
  const length = polylineLength(points);
  const [first] = points;
  if (!first || length <= 0) {
    return [...points];
  }
  const count = Math.max(1, Math.round(length / spacing));
  const result: Point[] = [first];
  let segment = 1;
  let walked = 0;
  for (let k = 1; k < count; k += 1) {
    const target = (k / count) * length;
    for (; segment < points.length; segment += 1) {
      const [ax = 0, ay = 0] = points[segment - 1] ?? [];
      const [bx = 0, by = 0] = points[segment] ?? [];
      const span = Math.hypot(bx - ax, by - ay);
      if (walked + span >= target) {
        const t = span > 0 ? (target - walked) / span : 0;
        result.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
        break;
      }
      walked += span;
    }
  }
  result.push(points.at(-1) ?? first);
  return result;
}

/** A meander's displacement and wavelength, in map units. */
interface Meander {
  amplitude: number;
  wavelength: number;
}

/** The octaves of every meander and undulation along a line. */
const lineNoise = { gain: 0.5, lacunarity: 2, octaves: 2 } as const;

/**
 * A polyline displaced sideways by seeded noise along its length, by up to
 * `amplitude` map units, the displacement faded to nothing at both ends so
 * the line still starts and finishes where it did.
 */
function meander(
  points: readonly Point[],
  shape: Meander,
  seed: number
): Point[] {
  const length = polylineLength(points);
  if (shape.amplitude <= 0 || points.length < 3 || length <= 0) {
    return [...points];
  }
  const wavelength = Math.max(shape.wavelength, 1e-6);
  let walked = 0;
  return points.map((point, index): Point => {
    const [x, y] = point;
    const [px = x, py = y] = points[Math.max(0, index - 1)] ?? point;
    const [nx = x, ny = y] =
      points[Math.min(points.length - 1, index + 1)] ?? point;
    if (index > 0) {
      walked += Math.hypot(x - px, y - py);
    }
    const span = Math.hypot(nx - px, ny - py) || 1;
    const offset =
      shape.amplitude *
      Math.sin(Math.PI * Math.min(1, walked / length)) *
      fbm(walked / wavelength, 0.37, seed, lineNoise);
    return [x - ((ny - py) / span) * offset, y + ((nx - px) / span) * offset];
  });
}

/**
 * The boundary between two regions near its narrows, as one ordered line:
 * boundary points within `extent` of the narrowest crossing's coast distance,
 * ordered across the line joining the regions' centres, cut to the one run
 * through the narrows, averaged into steps of two cells and smoothed.
 */
function traceSeam(
  points: readonly SeamPoint[],
  from: Point,
  to: Point,
  extent: number,
  cell: number
): Point[] {
  const narrowest = Math.min(...points.map((point) => point.distance));
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
  const across: Point = [
    -(to[1] - from[1]) / length,
    (to[0] - from[0]) / length,
  ];
  const mid: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  const near = points
    .filter((point) => point.distance <= narrowest + extent)
    .map((point) => ({
      ...point,
      t: (point.x - mid[0]) * across[0] + (point.y - mid[1]) * across[1],
    }))
    .sort((a, b) => a.t - b.t || a.x - b.x || a.y - b.y);
  const pivot = near.findIndex((point) => point.distance === narrowest);
  let start = Math.max(0, pivot);
  let end = start;
  const joined = (i: number, j: number) =>
    Math.abs((near[j]?.t ?? 0) - (near[i]?.t ?? 0)) <= 2 * cell;
  while (start > 0 && joined(start - 1, start)) {
    start -= 1;
  }
  while (end < near.length - 1 && joined(end, end + 1)) {
    end += 1;
  }
  const bin = 2 * cell;
  const bins = new Map<number, { count: number; x: number; y: number }>();
  for (const point of near.slice(start, end + 1)) {
    const key = Math.floor(point.t / bin);
    const entry = bins.get(key) ?? { count: 0, x: 0, y: 0 };
    entry.count += 1;
    entry.x += point.x;
    entry.y += point.y;
    bins.set(key, entry);
  }
  const line = [...bins]
    .sort(([a], [b]) => a - b)
    .map(([, entry]): Point => [entry.x / entry.count, entry.y / entry.count]);
  return smoothPolyline(line, 2);
}

/** Nearest point of a polyline: arc length to it and signed offset, positive to the left. */
function nearestOnPolyline(
  points: readonly Point[],
  x: number,
  y: number
): { along: number; offset: number } {
  let best = Number.POSITIVE_INFINITY;
  let along = 0;
  let offset = 0;
  let walked = 0;
  for (let index = 1; index < points.length; index += 1) {
    const [ax = 0, ay = 0] = points[index - 1] ?? [];
    const [bx = 0, by = 0] = points[index] ?? [];
    const dx = bx - ax;
    const dy = by - ay;
    const span = Math.hypot(dx, dy);
    const t =
      span > 0
        ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / span ** 2))
        : 0;
    const px = ax + dx * t;
    const py = ay + dy * t;
    const distance = Math.hypot(x - px, y - py);
    if (distance < best) {
      best = distance;
      along = walked + span * t;
      const side = dx * (y - ay) - dy * (x - ax);
      offset = side >= 0 ? distance : -distance;
    }
    walked += span;
  }
  return { along, offset };
}

/** The cells of a box in map units, clamped to the grid. */
function cropBox(
  grid: GeologyGrid,
  points: readonly Point[],
  reach: number
): { column: number; height: number; row: number; width: number } {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const column = Math.max(
    0,
    Math.floor((Math.min(...xs) - reach - grid.left) / grid.cell)
  );
  const row = Math.max(
    0,
    Math.floor((Math.min(...ys) - reach - grid.top) / grid.cell)
  );
  const right = Math.min(
    grid.width,
    Math.ceil((Math.max(...xs) + reach - grid.left) / grid.cell)
  );
  const bottom = Math.min(
    grid.height,
    Math.ceil((Math.max(...ys) + reach - grid.top) / grid.cell)
  );
  return {
    column,
    height: Math.max(0, bottom - row),
    row,
    width: Math.max(0, right - column),
  };
}

/** The crop cut to the cells it changes; none when it changes nothing. */
function tighten(
  id: string,
  box: { column: number; height: number; row: number; width: number },
  values: Float32Array
): SeabedContribution | undefined {
  let top = box.height;
  let bottom = -1;
  let left = box.width;
  let right = -1;
  for (let r = 0; r < box.height; r += 1) {
    for (let c = 0; c < box.width; c += 1) {
      if (values[r * box.width + c]) {
        top = Math.min(top, r);
        bottom = Math.max(bottom, r);
        left = Math.min(left, c);
        right = Math.max(right, c);
      }
    }
  }
  if (bottom < 0) {
    return;
  }
  const width = right - left + 1;
  const height = bottom - top + 1;
  const cropped = new Float32Array(width * height);
  for (let r = 0; r < height; r += 1) {
    cropped.set(
      values.subarray(
        (top + r) * box.width + left,
        (top + r) * box.width + left + width
      ),
      r * width
    );
  }
  return {
    column: box.column + left,
    height,
    id,
    row: box.row + top,
    values: cropped,
    width,
  };
}

/** How a feature meets the seabed: raised toward a crest, or carved toward a floor. */
interface Sculpt {
  field: CoastField;
  id: string;
  intensity: number;
  minRelief: number;
  /** +1 raises, -1 carves. */
  sign: 1 | -1;
  smoothing: number;
  /** The seabed so far, updated as each feature is applied. */
  working: Float32Array;
}

/**
 * Blends each sea cell of a crop toward a target, by an influence 0 to 1,
 * and applies the change to the working seabed. A raise only lifts cells
 * below its target; a carve only deepens cells above it. A feature that
 * changes no cell by `minRelief` changes nothing and has no contribution.
 */
function sculpt(
  options: Sculpt,
  box: { column: number; height: number; row: number; width: number },
  at: (x: number, y: number) => { influence: number; target: number }
): SeabedContribution | undefined {
  const { field, sign, smoothing, working } = options;
  const { grid } = field;
  const values = new Float32Array(box.width * box.height);
  let relief = 0;
  for (let r = 0; r < box.height; r += 1) {
    for (let c = 0; c < box.width; c += 1) {
      const index = (box.row + r) * grid.width + box.column + c;
      if (field.land[index]) {
        continue;
      }
      const [x, y] = centre(grid, index);
      const { influence, target } = at(x, y);
      if (influence < negligible) {
        continue;
      }
      const here = working[index] ?? geologyLevels.abyss;
      const change =
        sign * influence * smoothPositive(sign * (target - here), smoothing);
      values[r * box.width + c] = change * options.intensity;
      relief = Math.max(relief, Math.abs(change * options.intensity));
    }
  }
  if (relief < options.minRelief) {
    return;
  }
  for (let r = 0; r < box.height; r += 1) {
    for (let c = 0; c < box.width; c += 1) {
      const index = (box.row + r) * grid.width + box.column + c;
      working[index] =
        (working[index] ?? geologyLevels.abyss) +
        (values[r * box.width + c] ?? 0);
    }
  }
  return tighten(options.id, box, values);
}

/** +1 when the seabed to the left of a line's middle is deeper than to its right. */
function deeperSide(
  grid: GeologyGrid,
  elevation: ArrayLike<number>,
  points: readonly Point[],
  reach: number
): 1 | -1 {
  const middle = Math.floor(points.length / 2);
  const [ax = 0, ay = 0] = points[Math.max(0, middle - 1)] ?? [];
  const [bx = 0, by = 0] =
    points[Math.min(points.length - 1, middle + 1)] ?? [];
  const span = Math.hypot(bx - ax, by - ay) || 1;
  const nx = -(by - ay) / span;
  const ny = (bx - ax) / span;
  const [mx = 0, my = 0] = points[middle] ?? [];
  const left = sampleGrid(grid, elevation, mx + nx * reach, my + ny * reach);
  const right = sampleGrid(grid, elevation, mx - nx * reach, my - ny * reach);
  return left <= right ? 1 : -1;
}

/**
 * A line feature's profile and its target along its length, 0 to 1, with
 * an optional breadth that scales its widths along that length, at most
 * `widest`.
 */
interface StrokeShape {
  breadth?: { at: (t: number) => number; widest: number };
  profile: CrossSection;
  taper: number;
  target: (t: number) => number;
}

/** A line feature's contribution: its cross-section about the line, faded in at each end. */
function stroke(
  options: Sculpt,
  points: readonly Point[],
  shape: StrokeShape,
  elevation: ArrayLike<number>
): SeabedContribution | undefined {
  const { grid } = options.field;
  const { breadth, profile } = shape;
  const reach = crossSectionReach(profile) * Math.max(1, breadth?.widest ?? 1);
  const lean = deeperSide(grid, elevation, points, 2 * profile.width);
  const length = polylineLength(points);
  const taper = Math.max(1e-6, shape.taper);
  return sculpt(options, cropBox(grid, points, reach), (x, y) => {
    const { along, offset } = nearestOnPolyline(points, x, y);
    const t = length > 0 ? along / length : 0.5;
    const fade = smoothstep(0, taper, t) * smoothstep(0, taper, 1 - t);
    const scale = breadth ? Math.max(1e-3, breadth.at(t)) : 1;
    return {
      influence: fade * crossSection(offset * lean, scaled(profile, scale)),
      target: shape.target(t),
    };
  });
}

/** A cross-section with its widths scaled. */
function scaled(profile: CrossSection, scale: number): CrossSection {
  if (scale === 1) {
    return profile;
  }
  return {
    ...profile,
    width: profile.width * scale,
    ...(profile.shoulder && {
      shoulder: { ...profile.shoulder, width: profile.shoulder.width * scale },
    }),
  };
}

/** Seeded noise along a line, -1 to 1, at `along` map units over `wavelength`. */
function alongNoise(along: number, wavelength: number, seed: number): number {
  return fbm(along / Math.max(wavelength, 1e-6), 0.71, seed, lineNoise);
}

/** Strength of what ties two islands: their routes, both ways, and the shelves under both. */
interface Tie {
  route: number;
  shared: boolean;
  shelf: number;
}

function ties(input: SeafloorInput): Map<string, Tie> {
  const found = new Map<string, Tie>();
  const tie = (a: string, b: string) => {
    const key = pairKey(a, b);
    const entry = found.get(key) ?? { route: 0, shared: false, shelf: 0 };
    found.set(key, entry);
    return entry;
  };
  for (const link of input.links) {
    if (link.from !== link.to) {
      tie(link.from, link.to).route += Math.max(0, link.weight);
    }
  }
  for (const { source } of input.terrain.contributions) {
    const { members } = source;
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i];
        const b = members[j];
        if (!(a && b) || a.territoryId === b.territoryId) {
          continue;
        }
        const entry = tie(a.territoryId, b.territoryId);
        entry.shared = true;
        if (source.kind === "shared") {
          entry.shelf += source.weight * Math.min(a.amplitude, b.amplitude);
        }
      }
    }
  }
  return found;
}

/** A feature waiting to be built, with what it needs to build. */
interface Candidate {
  build: (options: Sculpt) => SeafloorFeature | undefined;
  id: string;
  strength: number;
}

/** Candidates strongest first, then by id; built in that order until the cap is met. */
function select(
  candidates: readonly Candidate[],
  cap: number,
  options: Omit<Sculpt, "id">,
  out: Seafloor
): void {
  const ranked = [...candidates].sort(
    (a, b) => b.strength - a.strength || a.id.localeCompare(b.id)
  );
  let built = 0;
  for (const candidate of ranked) {
    if (built >= cap) {
      return;
    }
    const sculptOptions = { ...options, id: candidate.id };
    const before = out.contributions.length;
    const feature = candidate.build(sculptOptions);
    if (feature && out.contributions.length > before) {
      out.features.push(feature);
      built += 1;
    }
  }
}

function pairLabel(
  a: SeafloorIsland,
  b: SeafloorIsland,
  name: string
): string | undefined {
  const [first, second] = [a, b].sort((p, q) => p.id.localeCompare(q.id));
  return first?.label && second?.label
    ? `${first.label}–${second.label} ${name}`
    : undefined;
}

interface Context {
  elevation: ArrayLike<number>;
  field: CoastField;
  input: SeafloorInput;
  islandPairs: Map<string, Neighbours>;
  out: Seafloor;
  settings: SeafloorSettings;
}

function islandPair(
  context: Context,
  pair: Neighbours
): [SeafloorIsland, SeafloorIsland] | undefined {
  const a = context.input.islands[pair.a];
  const b = context.input.islands[pair.b];
  return a && b ? [a, b] : undefined;
}

function ridgeCandidates(context: Context): Candidate[] {
  const { settings } = context;
  const { ridge } = settings;
  const tied = ties(context.input);
  return [...context.islandPairs.values()].flatMap((pair): Candidate[] => {
    const islands = islandPair(context, pair);
    if (!islands || pair.gap > ridge.maxGap) {
      return [];
    }
    const [a, b] = islands;
    const tie = tied.get(pairKey(a.id, b.id));
    if (!(tie && (tie.shelf > 0 || tie.route >= ridge.minRoute))) {
      return [];
    }
    const pull = tie.route / ridge.routeHalf + tie.shelf / ridge.shelfHalf;
    const strength = pull / (1 + pull);
    const id = `ridge:${pairKey(a.id, b.id)}`;
    return [
      {
        build: (options) => {
          const path = shallowestPath(
            context.field,
            context.elevation,
            pair.a,
            pair.b,
            ridge.depthCost
          );
          if (path.length < 3) {
            return;
          }
          const seed = noiseSeed(`${settings.seed}:${id}`);
          const points = meander(
            resample(smoothPolyline(path, 3), 2 * context.field.grid.cell),
            ridge.meander,
            seed
          );
          const length = polylineLength(points);
          const depth =
            ridge.depth.weak +
            (ridge.depth.strong - ridge.depth.weak) * strength;
          const saddle = boundedTarget(
            elevationAtDepth(depth),
            settings.smoothing
          );
          const { undulation } = ridge;
          const contribution = stroke(
            options,
            points,
            {
              profile: {
                asymmetry: ridge.asymmetry,
                shoulder: ridge.shoulder,
                width: ridge.width,
              },
              taper: ridge.taper,
              target: (t) =>
                boundedTarget(
                  saddle +
                    ridge.rise * (1 - Math.sin(Math.PI * t)) +
                    undulation.amplitude *
                      alongNoise(t * length, undulation.wavelength, seed + 1),
                  settings.smoothing
                ),
            },
            context.elevation
          );
          if (!contribution) {
            return;
          }
          context.out.contributions.push(contribution);
          return {
            elevation: saddle,
            geometry: { points, type: "polyline" },
            id,
            kind: "ridge",
            label: pairLabel(a, b, "Ridge"),
            members: [a.id, b.id].sort(),
            strength,
          };
        },
        id,
        strength,
      },
    ];
  });
}

/**
 * Settings shared by the two carved line features. A trough may meander,
 * widen and narrow along its length, and shoal toward its ends; one
 * without those settings runs straight, even and level.
 */
type TroughSettings = Pick<
  SeafloorSettings["channel"],
  "asymmetry" | "depth" | "extent" | "share" | "taper" | "width"
> &
  Partial<Pick<SeafloorSettings["channel"], "breadth" | "meander" | "shoal">>;

/** A carved trough along the seam between two regions. */
function trough(
  context: Context,
  options: Sculpt,
  seam: { from: Point; pair: Neighbours; to: Point },
  shape: { closeness: number; id: string; settings: TroughSettings }
): { elevation: number; points: Point[] } | undefined {
  const { cell } = context.field.grid;
  const { settings } = shape;
  const line = traceSeam(
    seam.pair.points,
    seam.from,
    seam.to,
    settings.extent,
    cell
  );
  const width = Math.min(settings.width, seam.pair.gap * settings.share);
  if (line.length < 3 || polylineLength(line) < 2 * width) {
    return;
  }
  const seed = noiseSeed(`${context.settings.seed}:${shape.id}`);
  const sway = settings.meander;
  const points = meander(
    resample(line, 2 * cell),
    {
      amplitude: sway
        ? Math.min(sway.amplitude, seam.pair.gap * sway.share)
        : 0,
      wavelength: sway?.wavelength ?? 1,
    },
    seed
  );
  const length = polylineLength(points);
  const depth =
    settings.depth.far +
    (settings.depth.near - settings.depth.far) * shape.closeness;
  const floor = boundedTarget(
    elevationAtDepth(depth),
    context.settings.smoothing
  );
  const ends = boundedTarget(
    elevationAtDepth(depth * (settings.shoal ?? 1)),
    context.settings.smoothing
  );
  const breadth = settings.breadth ?? 0;
  const contribution = stroke(
    options,
    points,
    {
      ...(breadth > 0 && {
        breadth: {
          at: (t: number) =>
            1 + breadth * alongNoise(t * length, 2 * width + 24, seed + 2),
          widest: 1 + breadth,
        },
      }),
      profile: { asymmetry: settings.asymmetry, width },
      taper: settings.taper,
      target: (t) => ends + (floor - ends) * Math.sin(Math.PI * t),
    },
    context.elevation
  );
  if (!contribution) {
    return;
  }
  context.out.contributions.push(contribution);
  return { elevation: floor, points };
}

function channelCandidates(context: Context): Candidate[] {
  const { channel } = context.settings;
  const tied = ties(context.input);
  return [...context.islandPairs.values()].flatMap((pair): Candidate[] => {
    const islands = islandPair(context, pair);
    if (!islands || pair.gap > channel.maxGap) {
      return [];
    }
    const [a, b] = islands;
    const sameGroup = (a.group ?? "") === (b.group ?? "");
    const tie = tied.get(pairKey(a.id, b.id));
    if (!sameGroup || tie?.shared || (tie?.route ?? 0) > 0) {
      return [];
    }
    const closeness = 1 - smoothstep(0, channel.maxGap, pair.gap);
    const id = `channel:${pairKey(a.id, b.id)}`;
    return [
      {
        build: (options) => {
          const carved = trough(
            context,
            options,
            { from: [a.x, a.y], pair, to: [b.x, b.y] },
            { closeness, id, settings: channel }
          );
          return (
            carved && {
              elevation: carved.elevation,
              geometry: { points: carved.points, type: "polyline" },
              id,
              kind: "channel",
              label: pairLabel(a, b, "Channel"),
              members: [a.id, b.id].sort(),
              strength: closeness,
            }
          );
        },
        id,
        strength: closeness,
      },
    ];
  });
}

function trenchCandidates(context: Context): Candidate[] {
  const { trench } = context.settings;
  const { islands } = context.input;
  const groups = [
    ...new Set(islands.map((island) => island.group ?? "")),
  ].sort();
  if (groups.length < 2) {
    return [];
  }
  const groupOf = Int32Array.from(islands, (island) =>
    groups.indexOf(island.group ?? "")
  );
  const { field } = context;
  const pairs = neighbours(field, (index) => {
    const island = field.nearest[index] ?? -1;
    return island >= 0 ? (groupOf[island] ?? -1) : -1;
  });
  const centroid = (group: number): Point => {
    const members = islands.filter((_, index) => groupOf[index] === group);
    return [
      members.reduce((sum, island) => sum + island.x, 0) / members.length,
      members.reduce((sum, island) => sum + island.y, 0) / members.length,
    ];
  };
  return [...pairs.values()].flatMap((pair): Candidate[] => {
    const a = groups[pair.a];
    const b = groups[pair.b];
    if (a === undefined || b === undefined || pair.gap > trench.maxGap) {
      return [];
    }
    const closeness = 1 - smoothstep(0, trench.maxGap, pair.gap);
    const id = `trench:${pairKey(a, b)}`;
    return [
      {
        build: (options) => {
          const carved = trough(
            context,
            options,
            { from: centroid(pair.a), pair, to: centroid(pair.b) },
            { closeness, id, settings: trench }
          );
          return (
            carved && {
              elevation: carved.elevation,
              geometry: { points: carved.points, type: "polyline" },
              id,
              kind: "trench",
              members: [a, b].sort(),
              strength: closeness,
            }
          );
        },
        id,
        strength: closeness,
      },
    ];
  });
}

/** Lattice cells round the circle a seamount's lobes are read on: about four lobes round a summit. */
const lobeFrequency = 1.2;

function seamountCandidates(context: Context): Candidate[] {
  const { settings } = context;
  const { seamount } = settings;
  const { grid } = context.field;
  return context.input.summits.map((summit): Candidate => {
    const strength = Math.min(1, Math.max(0, summit.strength ?? 1));
    const id = `seamount:${summit.id}`;
    return {
      build: (options) => {
        // At its nominal depth, or a rise over the seabed beneath it where that is shallower.
        const crest = boundedTarget(
          Math.max(
            elevationAtDepth(seamount.depth / Math.max(strength, 1e-6)),
            sampleGrid(grid, context.elevation, summit.x, summit.y) +
              seamount.rise * strength
          ),
          settings.smoothing
        );
        const [gx, gy] = gradientGrid(
          grid,
          context.elevation,
          summit.x,
          summit.y
        );
        const slope = Math.hypot(gx, gy);
        // The flank facing down the seabed's slope is the longer one.
        const down: Point = slope > 0 ? [-gx / slope, -gy / slope] : [0, 0];
        const asymmetry = slope > 0 ? seamount.asymmetry : 0;
        const profile = {
          asymmetry,
          plateau: seamount.plateau,
          width: seamount.width,
        };
        const lobes = Math.min(0.9, Math.max(0, seamount.lobes));
        const seed = noiseSeed(`${settings.seed}:${id}`);
        const contribution = sculpt(
          options,
          cropBox(
            grid,
            [[summit.x, summit.y]],
            crossSectionReach(profile) * (1 + lobes)
          ),
          (x, y) => {
            const dx = x - summit.x;
            const dy = y - summit.y;
            const radius = Math.hypot(dx, dy);
            // The flank widens smoothly toward the downslope side, and its
            // lobes come from noise round a circle, so they close on themselves.
            const facing =
              radius > 0 ? (dx * down[0] + dy * down[1]) / radius : 0;
            const angle = Math.atan2(dy, dx);
            const lobe =
              1 +
              lobes *
                gradientNoise(
                  lobeFrequency * Math.cos(angle) + 7.1,
                  lobeFrequency * Math.sin(angle) - 3.3,
                  seed
                );
            return {
              influence: crossSection(
                radius / (lobe * (1 + asymmetry * facing)),
                {
                  asymmetry: 0,
                  plateau: seamount.plateau,
                  width: seamount.width,
                }
              ),
              target: crest,
            };
          }
        );
        if (!contribution) {
          return;
        }
        context.out.contributions.push(contribution);
        return {
          elevation: crest,
          geometry: { point: [summit.x, summit.y], type: "point" },
          id,
          kind: "seamount",
          ...(summit.label && { label: summit.label }),
          members: [...summit.members].sort(),
          strength,
        };
      },
      id,
      strength,
    };
  });
}

/** A traced fall down the escarpment, from a head on the rim to its foot. */
interface Fall {
  /** The cell the fall heads from. */
  head: number;
  /** The island nearest the head. */
  island: number;
  points: Point[];
}

/** Map units each step of a fall's trace advances. */
const fallStep = 1;
/** The most steps, in cells, a fall's trace takes before giving up. */
const fallSteps = 120;
/** Share of the new downhill direction each step of a trace takes; the rest keeps its heading, so it crosses a flat bench. */
const fallTurn = 0.45;
/** Map units of seeded jitter in a head's rank, beside its distance from the nearest coast. */
const headJitter = 60;

/** The seabed's gradient at a map position, by central differences over two cells. */
function broadGradient(
  grid: GeologyGrid,
  elevation: ArrayLike<number>,
  x: number,
  y: number
): Point {
  const h = 2 * grid.cell;
  return [
    (sampleGrid(grid, elevation, x + h, y) -
      sampleGrid(grid, elevation, x - h, y)) /
      (2 * h),
    (sampleGrid(grid, elevation, x, y + h) -
      sampleGrid(grid, elevation, x, y - h)) /
      (2 * h),
  ];
}

/**
 * One trace over the seabed from a point, a cell at a time, downhill
 * (`sign` -1) or uphill (+1), each step turning only partly toward the new
 * slope so it crosses the benches. It stops where `stop` says, on land,
 * near a coast, or off the grid.
 */
function trace(
  context: Context,
  start: Point,
  sign: 1 | -1,
  stop: (point: Point, taken: number) => boolean
): { points: Point[]; stopped: boolean } {
  const { field } = context;
  const { grid } = field;
  const points: Point[] = [];
  let [x, y] = start;
  let heading: Point = [0, 0];
  for (let taken = 0; taken < fallSteps; taken += 1) {
    const [gx, gy] = broadGradient(grid, context.elevation, x, y);
    const slope = Math.hypot(gx, gy);
    const turn = slope > 1e-9 ? fallTurn : 0;
    const hx =
      (1 - turn) * heading[0] + (turn * sign * gx) / Math.max(slope, 1e-9);
    const hy =
      (1 - turn) * heading[1] + (turn * sign * gy) / Math.max(slope, 1e-9);
    const length = Math.hypot(hx, hy);
    if (length < 1e-6) {
      if (slope <= 1e-9) {
        break;
      }
      heading = [(sign * gx) / slope, (sign * gy) / slope];
    } else {
      heading = [hx / length, hy / length];
    }
    x += heading[0] * fallStep * grid.cell;
    y += heading[1] * fallStep * grid.cell;
    const column = Math.floor((x - grid.left) / grid.cell);
    const row = Math.floor((y - grid.top) / grid.cell);
    if (column < 0 || row < 0 || column >= grid.width || row >= grid.height) {
      break;
    }
    const index = row * grid.width + column;
    if (field.land[index] || (field.distance[index] ?? 0) < 2 * grid.cell) {
      break;
    }
    points.push([x, y]);
    if (stop([x, y], taken)) {
      return { points, stopped: true };
    }
  }
  return { points, stopped: false };
}

/**
 * A fall from a head on the rim: traced up into the platform for `reach`
 * map units, then down the escarpment until the seabed is as deep as
 * `end`; none when the trace never gets there, as from a basin's edge
 * inside the platform.
 */
function traceFall(
  context: Context,
  head: number,
  shape: { end: number; reach: number }
): Fall | undefined {
  const { field } = context;
  const start = centre(field.grid, head);
  const floor = elevationAtDepth(shape.end);
  const down = trace(
    context,
    start,
    -1,
    ([x, y]) => sampleGrid(field.grid, context.elevation, x, y) <= floor
  );
  if (!down.stopped) {
    return;
  }
  const climb = Math.ceil(shape.reach / field.grid.cell);
  const up =
    climb > 0
      ? trace(context, start, 1, (_, taken) => taken + 1 >= climb).points
      : [];
  return {
    head,
    island: field.nearest[head] ?? -1,
    points: [...up.reverse(), start, ...down.points],
  };
}

/**
 * Sea cells that may head a fall: between the head's depths, at least
 * `offshore` from the nearest coast, with a neighbour shallower than its
 * shallow depth and the escarpment's depths near, so on the rim's lip.
 */
function headCells(context: Context): number[] {
  const { field, settings } = context;
  const { grid } = field;
  const { head, offshore } = settings.canyon;
  const shallow = elevationAtDepth(head.shallow);
  const deep = elevationAtDepth(head.deep);
  const heads: number[] = [];
  for (let row = 1; row < grid.height - 1; row += 1) {
    for (let column = 1; column < grid.width - 1; column += 1) {
      const index = row * grid.width + column;
      const value = context.elevation[index] ?? geologyLevels.abyss;
      if (
        field.land[index] ||
        value > shallow ||
        value < deep ||
        (field.distance[index] ?? 0) < offshore
      ) {
        continue;
      }
      const lip = [
        index - 1,
        index + 1,
        index - grid.width,
        index + grid.width,
      ].some((next) => (context.elevation[next] ?? 0) > shallow);
      if (lip && nearSlope(context, index)) {
        heads.push(index);
      }
    }
  }
  return heads;
}

/** Map units round a head within which the escarpment must already fall past `slopeDepth`. */
const slopeReach = 40;
/** Nominal metres the seabed within `slopeReach` of a head must fall past: the escarpment's, not a basin's. */
const slopeDepth = 500;

/**
 * Whether the seabed falls past `slopeDepth` within `slopeReach` of a
 * cell, read in eight directions: a cheap test that keeps the falls'
 * traces to the rim, since a basin's edge inside the platform has no such
 * depth near it.
 */
function nearSlope(context: Context, index: number): boolean {
  const { grid } = context.field;
  const [x, y] = centre(grid, index);
  const deep = elevationAtDepth(slopeDepth);
  for (let k = 0; k < 8; k += 1) {
    const angle = (k * Math.PI) / 4;
    const value = sampleGrid(
      grid,
      context.elevation,
      x + slopeReach * Math.cos(angle),
      y + slopeReach * Math.sin(angle)
    );
    if (value < deep) {
      return true;
    }
  }
  return false;
}

/** A seeded number, 0 to 1, for a cell. */
function cellChance(index: number, seed: number): number {
  return latticeHash(index, 0, seed) / 4_294_967_296;
}

/**
 * The escarpment's falls: canyon heads first, ranked by distance from the
 * nearest coast so a canyon heads where an island stands nearest the edge,
 * then spur heads by seeded chance. The canyons' ranks carry a seeded
 * jitter. Each head stands at least `spacing` from every head taken, and
 * is kept only if its trace reaches the foot, so a basin's edge inside the
 * platform heads nothing.
 */
function escarpmentFalls(context: Context): { canyons: Fall[]; spurs: Fall[] } {
  const { canyon, spur } = context.settings;
  const cells = headCells(context);
  const seed = noiseSeed(`${context.settings.seed}:heads`);
  const { distance, grid } = context.field;
  const taken: Point[] = [];
  const pick = (ranked: number[], cap: number, reach: number): Fall[] => {
    const falls: Fall[] = [];
    for (const index of ranked) {
      if (falls.length >= cap) {
        break;
      }
      const [x, y] = centre(grid, index);
      if (
        taken.some(([tx, ty]) => Math.hypot(x - tx, y - ty) < canyon.spacing)
      ) {
        continue;
      }
      const fall = traceFall(context, index, { end: canyon.end, reach });
      if (fall) {
        falls.push(fall);
        taken.push([x, y]);
      }
    }
    return falls;
  };
  const byCoast = [...cells].sort(
    (a, b) =>
      (distance[a] ?? 0) +
        headJitter * cellChance(a, seed) -
        ((distance[b] ?? 0) + headJitter * cellChance(b, seed)) || a - b
  );
  const canyons = pick(byCoast, canyon.cap, canyon.headReach);
  const byChance = [...cells].sort(
    (a, b) => cellChance(a, seed + 1) - cellChance(b, seed + 1) || a - b
  );
  return { canyons, spurs: pick(byChance, spur.cap, 0) };
}

/** The seabed's elevation along a polyline, read at a share of its points, 0 to 1. */
function profileAlong(
  grid: GeologyGrid,
  elevation: ArrayLike<number>,
  points: readonly Point[]
): (t: number) => number {
  const values = points.map(([x, y]) => sampleGrid(grid, elevation, x, y));
  return (t) => {
    const u = Math.min(1, Math.max(0, t)) * (values.length - 1);
    const index = Math.min(values.length - 2, Math.floor(u));
    const a = values[index] ?? 0;
    const b = values[index + 1] ?? a;
    return a + (b - a) * (u - index);
  };
}

/**
 * Canyons and spurs down the escarpment, each from a traced fall: a canyon
 * carves `incision` below the slope it follows, a spur raises `rise` above
 * it, each fading out on the lower slope.
 */
function fallCandidates(context: Context): {
  canyons: Candidate[];
  spurs: Candidate[];
} {
  const { settings } = context;
  const { grid } = context.field;
  const falls = escarpmentFalls(context);
  const build = (
    fall: Fall,
    rank: number,
    kind: "canyon" | "spur"
  ): Candidate => {
    const island = context.input.islands[fall.island];
    const column = fall.head % grid.width;
    const row = (fall.head - column) / grid.width;
    const id = `${kind}:${column},${row}`;
    const strength = 1 / (1 + rank);
    const shape = settings[kind];
    return {
      build: (options) => {
        const seed = noiseSeed(`${settings.seed}:${id}`);
        const points = meander(
          resample(smoothPolyline(fall.points, 2), 2 * grid.cell),
          shape.meander,
          seed
        );
        if (points.length < 4) {
          return;
        }
        const along = profileAlong(grid, context.elevation, points);
        const sign = kind === "canyon" ? -1 : 1;
        const relief =
          kind === "canyon" ? settings.canyon.incision : settings.spur.rise;
        const contribution = stroke(
          options,
          points,
          {
            profile: { asymmetry: 0, width: shape.width },
            taper: shape.taper,
            target: (t) =>
              boundedTarget(
                along(t) + sign * relief * (1 - smoothstep(0.6, 1, t)),
                settings.smoothing
              ),
          },
          context.elevation
        );
        if (!contribution) {
          return;
        }
        context.out.contributions.push(contribution);
        return {
          elevation: boundedTarget(along(0.5) + sign * relief, 0),
          geometry: { points, type: "polyline" },
          id,
          kind,
          ...(island?.label && {
            label: `${island.label} ${kind === "canyon" ? "Canyon" : "Spur"}`,
          }),
          members: island ? [island.id] : [],
          strength,
        };
      },
      id,
      strength,
    };
  };
  return {
    canyons: falls.canyons.map((fall, rank) => build(fall, rank, "canyon")),
    spurs: falls.spurs.map((fall, rank) => build(fall, rank, "spur")),
  };
}

/**
 * The seabed's named features and their contributions, from the islands,
 * their routes, the structural terrain's shelves, and things without an
 * island. Trenches are carved first, then channels, then ridges are raised,
 * then seamounts, then canyons are carved and spurs raised down the
 * escarpment; within a kind, the strongest first. Each kind stops at its
 * cap, so open water stays open.
 */
export function seafloorFeatures(
  input: SeafloorInput,
  settings: SeafloorSettings = defaultSeafloorSettings
): Seafloor {
  const { terrain } = input;
  const grid: GeologyGrid = {
    cell: terrain.cell,
    height: terrain.height,
    left: terrain.left,
    top: terrain.top,
    width: terrain.width,
  };
  const islands = [...input.islands].sort((a, b) => a.id.localeCompare(b.id));
  const sorted: SeafloorInput = { ...input, islands };
  const field = coastField(grid, islands, terrain.signedDistance);
  const out: Seafloor = { contributions: [], features: [] };
  const { elevation } = terrain.surface;
  const context: Context = {
    elevation,
    field,
    input: sorted,
    islandPairs: neighbours(field, (index) => field.nearest[index] ?? -1),
    out,
    settings,
  };
  const options = {
    field,
    intensity: Math.min(1, Math.max(0, settings.intensity)),
    minRelief: Math.max(0, settings.minRelief),
    smoothing: settings.smoothing,
    working: Float32Array.from(elevation),
  };
  select(
    trenchCandidates(context),
    settings.trench.cap,
    { ...options, sign: -1 },
    out
  );
  select(
    channelCandidates(context),
    settings.channel.cap,
    { ...options, sign: -1 },
    out
  );
  select(
    ridgeCandidates(context),
    settings.ridge.cap,
    { ...options, sign: 1 },
    out
  );
  select(
    seamountCandidates(context),
    settings.seamount.cap,
    { ...options, sign: 1 },
    out
  );
  const falls = fallCandidates(context);
  select(falls.canyons, settings.canyon.cap, { ...options, sign: -1 }, out);
  select(falls.spurs, settings.spur.cap, { ...options, sign: 1 }, out);
  return out;
}
