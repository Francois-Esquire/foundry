import { contours } from "d3-contour";
import { shoreDistances } from "./distance-field";
import { fillPolygon } from "./scanline-fill";
import type {
  DependencyFoundation,
  FoundationGroup,
  InternalFoundation,
  Polygon,
} from "./types";

/**
 * The structural terrain under the islands, from the settled layout. The
 * convention, its worked example, and the boundaries taken from it are in
 * `docs/spyglass/_terrain.md`. In short: water level is 0, land is above it,
 * the abyss is -1, and structure lifts the seabed toward the surface in two
 * bands. Internal workspace foundations raise a broad, deep basement; shared
 * third-party groups raise shelves on it. Neither band reaches the water, so
 * every shoreline is an island's own. How many relationships lie under a
 * point is kept apart from elevation, as unbounded thickness.
 */
export const terrainLevels = {
  abyss: -1,
  /** The highest an internal basement rises. */
  basementTop: -0.6,
  /** Full land height, reached `land` map units inland. */
  land: 1,
  /** The highest a shared shelf rises; below water, so a shelf is never coast. */
  shelfTop: -0.14,
  waterLevel: 0,
} as const;

/** How one relationship's influence falls off beyond a member's coast. */
export interface FalloffProfile {
  /** 1 is exponential, 2 Gaussian; larger exponents give a steeper face. */
  exponent: number;
  /** Map units beyond the coast where the influence stays full. */
  plateau: number;
  /** Map units over which it then falls to about 1/e. */
  width: number;
}

export const defaultTerrainSettings = {
  /** Internal foundations: broad and gentle. */
  basement: { exponent: 1.6, plateau: 30, width: 80 },
  /** Basement thickness at which the basement is half risen. */
  basementHalf: 8,
  /** Map units per cell of the terrain grid. */
  cell: 4,
  /** Each island's own descent from its coast toward the abyss. */
  coast: { exponent: 1, plateau: 0, width: 24 },
  /**
   * A dependent's share of a supplier's influence: the basement centres on
   * the package relied upon and reaches more weakly under those relying on it.
   */
  dependentShare: 0.5,
  /** Map units inland at which land reaches full height. */
  land: 40,
  /**
   * Around an island outside a relationship, its influence is held off for
   * `clearance` map units and returns over `width`: a recess, not a shelf
   * under unrelated land.
   */
  recess: { clearance: 12, width: 30 },
  /** Shared groups: a closer plateau with a steeper face. */
  shelf: { exponent: 2.4, plateau: 26, width: 48 },
  /** Shelf thickness at which a shelf is half risen above its base. */
  shelfHalf: 4,
  /** Lift above the abyss, 0 to 1, that the outer silhouette encloses. */
  silhouetteLift: 0.1,
  /** Smooth-maximum width where an island's descent meets the shelves. */
  smoothing: 0.08,
  /** Extra plateau a supplier's own lobe takes as its dependents grow. */
  supplierReach: 80,
};
export type TerrainSettings = typeof defaultTerrainSettings;

export interface TerrainIsland {
  coast: readonly Polygon[];
  id: string;
  radius: number;
  x: number;
  y: number;
}

/** One relationship's source: who takes part, and how much it adds at full influence. */
export interface TerrainContributionSource {
  /** Third-party dependencies a shared group represents; none for an internal foundation. */
  dependencyIds: readonly string[];
  id: string;
  kind: "internal" | "shared";
  members: readonly {
    /** 0 to 1: how strongly this member takes part. */
    amplitude: number;
    /** A supplier's lobe reaches farther than a dependent's. */
    supplier?: boolean;
    territoryId: string;
  }[];
  /** Thickness added where the influence is full. */
  weight: number;
}

export interface TerrainInput {
  contributions: readonly TerrainContributionSource[];
  /** The chart's extent, centred on the origin. */
  extent: { height: number; width: number };
  islands: readonly TerrainIsland[];
}

/** A contribution's influence, 0 to 1, on its own crop of the grid. */
export interface TerrainContribution {
  column: number;
  height: number;
  row: number;
  source: TerrainContributionSource;
  values: Float32Array;
  width: number;
}

/** One composition of the contributions: thickness by band, and the elevation they give. */
export interface TerrainSurface {
  basement: Float32Array;
  elevation: Float32Array;
  shelf: Float32Array;
}

export interface StructuralTerrain {
  /** Map units per cell. */
  cell: number;
  /** Recomposes from cached contributions; never re-measures distance. */
  compose(options?: { focus?: string; foundations?: boolean }): TerrainSurface;
  contributions: readonly TerrainContribution[];
  height: number;
  key: string;
  /** Map position of the grid's west and north edges. */
  left: number;
  settings: TerrainSettings;
  /** Map units to the nearest coast, negative on land. */
  signedDistance: Float32Array;
  /** The full composition, every contribution included. */
  surface: TerrainSurface;
  top: number;
  width: number;
}

interface IslandCrop {
  /** The coast's own bounds within the crop, in its cells. */
  coast: { bottom: number; left: number; right: number; top: number };
  column: number;
  height: number;
  row: number;
  /** Map units, negative on land. */
  sdf: Float32Array;
  width: number;
}

/** Influence below this is no influence: it bounds each profile's reach. */
const negligible = 0.002;

/** 1 within the plateau, then `exp(-(d / width) ^ exponent)` beyond it. */
export function falloff(distance: number, profile: FalloffProfile): number {
  const beyond = distance - profile.plateau;
  if (beyond <= 0) {
    return 1;
  }
  return Math.exp(
    -((beyond / Math.max(profile.width, 1e-6)) ** profile.exponent)
  );
}

/** Map units past the coast at which a profile becomes negligible. */
export function falloffReach(profile: FalloffProfile): number {
  return (
    profile.plateau +
    profile.width * Math.log(1 / negligible) ** (1 / profile.exponent)
  );
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/**
 * Polynomial smooth maximum, equal to `max` once the two differ by `k`. Its
 * rounding fades toward the abyss, so an empty seabed stays exactly abyssal.
 */
function smoothMax(a: number, b: number, k: number): number {
  const highest = Math.max(a, b);
  if (k <= 0) {
    return highest;
  }
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return highest + ((h * h * k) / 4) * terrainLift(highest);
}

/** Saturating thickness: 0 at none, one half at `half`, approaching 1. */
function saturate(thickness: number, half: number): number {
  return thickness > 0 ? thickness / (thickness + half) : 0;
}

/** How far a supplier's lobe extends its plateau for its number of dependents. */
function supplierExtent(prominence: number, settings: TerrainSettings) {
  return (settings.supplierReach * prominence) / (prominence + 3);
}

/**
 * Terrain sources from the prepared relationships. A shared group weighs the
 * sum of its dependencies' mean member weights, so one shared dependency is
 * about 1 and ten about 10, and transitive reliance counts less. An internal
 * foundation weighs its attenuated dependents. Every group and foundation is
 * kept; none is cut off by rank.
 */
export function terrainContributions(
  groups: readonly FoundationGroup[],
  foundations: readonly Pick<DependencyFoundation, "id" | "members">[],
  internal: readonly InternalFoundation[] = [],
  settings: Pick<TerrainSettings, "dependentShare"> = defaultTerrainSettings
): TerrainContributionSource[] {
  const byId = new Map(foundations.map((item) => [item.id, item]));
  const shared = groups.map((group): TerrainContributionSource => {
    const amplitudes = new Map<string, number[]>();
    let weight = 0;
    for (const id of group.dependencyIds) {
      const members = byId.get(id)?.members ?? [];
      weight += members.length
        ? members.reduce((sum, member) => sum + member.weight, 0) /
          members.length
        : 1;
      for (const member of members) {
        const list = amplitudes.get(member.territoryId) ?? [];
        list.push(member.weight);
        amplitudes.set(member.territoryId, list);
      }
    }
    return {
      dependencyIds: [...group.dependencyIds],
      id: group.id,
      kind: "shared",
      members: [...group.memberIds].sort().map((territoryId) => {
        const weights = amplitudes.get(territoryId) ?? [1];
        return {
          amplitude: Math.min(1, Math.max(...weights)),
          territoryId,
        };
      }),
      weight,
    };
  });
  const workspace = internal.map(
    (foundation): TerrainContributionSource => ({
      dependencyIds: [],
      id: foundation.id,
      kind: "internal",
      members: [
        { amplitude: 1, supplier: true, territoryId: foundation.supplierId },
        ...[...foundation.members]
          .sort((a, b) => a.territoryId.localeCompare(b.territoryId))
          .map((member) => ({
            amplitude: Math.min(1, member.weight) * settings.dependentShare,
            territoryId: member.territoryId,
          })),
      ],
      weight: foundation.members.reduce(
        (sum, member) => sum + member.weight,
        0
      ),
    })
  );
  return [...shared, ...workspace].sort((a, b) => a.id.localeCompare(b.id));
}

/** Content identity for the terrain cache, never a security hash. */
function terrainKey(input: TerrainInput, settings: TerrainSettings): string {
  const json = JSON.stringify([
    settings,
    input.extent.width,
    input.extent.height,
    [...input.islands]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((island) => [
        island.id,
        island.x,
        island.y,
        island.radius,
        island.coast,
      ]),
    input.contributions,
  ]);
  let hash = 2_166_136_261;
  for (let index = 0; index < json.length; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: A deterministic 32-bit hash identifies cached terrain.
    hash = Math.imul(hash ^ json.charCodeAt(index), 16_777_619) >>> 0;
  }
  return `${json.length}:${hash.toString(16)}`;
}

const cache = new Map<string, StructuralTerrain>();
/** Scenes rebuild for a relayout; two entries cover the current and previous layout. */
const cacheEntries = 2;

/** The terrain for a layout, built once per content and reused while it is unchanged. */
export function structuralTerrain(
  input: TerrainInput,
  settings: TerrainSettings = defaultTerrainSettings
): StructuralTerrain {
  const key = terrainKey(input, settings);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const terrain = buildTerrain(input, settings, key);
  cache.set(key, terrain);
  while (cache.size > cacheEntries) {
    const [oldest] = cache.keys();
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
  return terrain;
}

function buildTerrain(
  input: TerrainInput,
  settings: TerrainSettings,
  key: string
): StructuralTerrain {
  const cell = Math.max(0.5, settings.cell);
  const reach = Math.max(
    falloffReach(settings.shelf),
    falloffReach(settings.basement) + settings.supplierReach,
    settings.recess.clearance + settings.recess.width,
    falloffReach(settings.coast)
  );
  const extentWidth = Number.isFinite(input.extent.width)
    ? Math.max(0, input.extent.width)
    : 0;
  const extentHeight = Number.isFinite(input.extent.height)
    ? Math.max(0, input.extent.height)
    : 0;
  const width = Math.max(2, Math.ceil((extentWidth + 2 * reach) / cell));
  const height = Math.max(2, Math.ceil((extentHeight + 2 * reach) / cell));
  const left = -(width * cell) / 2;
  const top = -(height * cell) / 2;
  const crops = new Map(
    input.islands.map((island) => [
      island.id,
      islandCrop(island, { cell, height, left, top, width }, reach),
    ])
  );
  const signedDistance = new Float32Array(width * height).fill(
    Number.POSITIVE_INFINITY
  );
  for (const crop of crops.values()) {
    eachCell(crop, width, height, (local, global) => {
      signedDistance[global] = Math.min(
        signedDistance[global] ?? Number.POSITIVE_INFINITY,
        crop.sdf[local] ?? Number.POSITIVE_INFINITY
      );
    });
  }
  const contributions = input.contributions.flatMap((source) => {
    const contribution = contributionField(
      source,
      crops,
      { cell, height, width },
      settings
    );
    return contribution ? [contribution] : [];
  });
  const compositions = new Map<string, TerrainSurface>();
  const compose: StructuralTerrain["compose"] = (options = {}) => {
    const focus = options.focus ?? "";
    const included = options.foundations ?? true;
    const id = JSON.stringify([focus, included]);
    let surface = compositions.get(id);
    if (!surface) {
      surface = composeSurface(
        included
          ? contributions.filter(
              ({ source }) =>
                !focus ||
                source.id === focus ||
                source.dependencyIds.includes(focus)
            )
          : [],
        signedDistance,
        { height, width },
        settings
      );
      compositions.set(id, surface);
    }
    return surface;
  };
  return {
    cell,
    compose,
    contributions,
    height,
    key,
    left,
    settings,
    signedDistance,
    surface: compose(),
    top,
    width,
  };
}

/**
 * The rows and columns of a crop within `reach` map units of its coast,
 * placed at `offset`, that fall within a `width` by `height` grid: beyond
 * that reach the crop's distances can change nothing.
 */
function overlap(
  crop: IslandCrop,
  offset: { column: number; row: number },
  grid: { cell: number; height: number; width: number },
  reach: number
) {
  const cells = Math.ceil(reach / grid.cell) + 1;
  return {
    bottom: Math.min(
      crop.height,
      crop.coast.bottom + cells,
      grid.height - offset.row
    ),
    left: Math.max(0, crop.coast.left - cells, -offset.column),
    right: Math.min(
      crop.width,
      crop.coast.right + cells,
      grid.width - offset.column
    ),
    top: Math.max(0, crop.coast.top - cells, -offset.row),
  };
}

/** Visits a crop's cells that lie on the grid, with local and global indices. */
function eachCell(
  crop: Pick<IslandCrop, "column" | "height" | "row" | "width">,
  width: number,
  height: number,
  visit: (local: number, global: number) => void
): void {
  for (let r = Math.max(0, -crop.row); r < crop.height; r += 1) {
    const row = crop.row + r;
    if (row >= height) {
      break;
    }
    for (let c = Math.max(0, -crop.column); c < crop.width; c += 1) {
      const column = crop.column + c;
      if (column >= width) {
        break;
      }
      visit(r * crop.width + c, row * width + column);
    }
  }
}

/** A circle where an island has no coast yet, as its footprint radius. */
function fallbackCoast(radius: number): Polygon[] {
  const ring: [number, number][] = Array.from({ length: 32 }, (_, i) => [
    Math.cos((i * Math.PI) / 16) * radius,
    Math.sin((i * Math.PI) / 16) * radius,
  ]);
  return [[ring]];
}

/** One island's signed distance over its own crop: as far as anything reaches. */
function islandCrop(
  island: TerrainIsland,
  grid: {
    cell: number;
    height: number;
    left: number;
    top: number;
    width: number;
  },
  reach: number
): IslandCrop {
  const coast = island.coast.length
    ? island.coast
    : fallbackCoast(Math.max(1, island.radius));
  const points = coast.flatMap((polygon) => polygon[0] ?? []);
  const xs = points.map(([x]) => island.x + x);
  const ys = points.map(([, y]) => island.y + y);
  const margin = reach + grid.cell * 2;
  const marginCells = Math.ceil(margin / grid.cell);
  const column = Math.floor((Math.min(...xs) - margin - grid.left) / grid.cell);
  const row = Math.floor((Math.min(...ys) - margin - grid.top) / grid.cell);
  const width = Math.max(
    2,
    Math.ceil((Math.max(...xs) + margin - grid.left) / grid.cell) - column
  );
  const height = Math.max(
    2,
    Math.ceil((Math.max(...ys) + margin - grid.top) / grid.cell) - row
  );
  const land = new Uint8Array(width * height);
  for (const polygon of coast) {
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
  const outside = shoreDistances(land, width, height);
  const inside = insideDistances(land, width, height, marginCells - 1);
  // Cell centres sit half a cell from the boundary between land and water.
  const sdf = Float32Array.from(land, (cell, index) =>
    cell
      ? -Math.max(0, (inside[index] ?? 0) - 0.5) * grid.cell
      : Math.max(0, (outside[index] ?? 0) - 0.5) * grid.cell
  );
  return {
    coast: {
      bottom: height - marginCells,
      left: marginCells,
      right: width - marginCells,
      top: marginCells,
    },
    column,
    height,
    row,
    sdf,
    width,
  };
}

/**
 * Distance from each land cell to the nearest water cell, measured only
 * over the coast's own bounds and a cell of water around them: the crop's
 * margin is water throughout, so nothing beyond that cell is nearer.
 */
function insideDistances(
  land: Uint8Array,
  width: number,
  height: number,
  margin: number
): Float32Array {
  const inner = Math.max(0, margin - 1);
  const innerWidth = Math.max(1, width - 2 * inner);
  const innerHeight = Math.max(1, height - 2 * inner);
  const water = new Uint8Array(innerWidth * innerHeight);
  for (let r = 0; r < innerHeight; r += 1) {
    for (let c = 0; c < innerWidth; c += 1) {
      water[r * innerWidth + c] =
        1 - (land[(r + inner) * width + c + inner] ?? 0);
    }
  }
  const measured = shoreDistances(water, innerWidth, innerHeight);
  const distances = new Float32Array(width * height);
  for (let r = 0; r < innerHeight; r += 1) {
    for (let c = 0; c < innerWidth; c += 1) {
      distances[(r + inner) * width + c + inner] =
        measured[r * innerWidth + c] ?? 0;
    }
  }
  return distances;
}

/** A contribution's crop of the grid, in cells, and the grid's cell size. */
interface ContributionFrame {
  cell: number;
  column: number;
  height: number;
  row: number;
  width: number;
}

/** Multiplies one member's lobe into a contribution's complement: a probabilistic union. */
function unionLobe(
  complement: Float32Array,
  frame: ContributionFrame,
  crop: IslandCrop,
  amplitude: number,
  lobe: FalloffProfile
): void {
  const offset = {
    column: crop.column - frame.column,
    row: crop.row - frame.row,
  };
  const span = overlap(crop, offset, frame, falloffReach(lobe));
  for (let r = span.top; r < span.bottom; r += 1) {
    for (let c = span.left; c < span.right; c += 1) {
      const target = (r + offset.row) * frame.width + c + offset.column;
      const distance = crop.sdf[r * crop.width + c] ?? Number.POSITIVE_INFINITY;
      complement[target] =
        (complement[target] ?? 1) * (1 - amplitude * falloff(distance, lobe));
    }
  }
}

/** Holds a contribution off near an island outside it, so a recess forms there. */
function holdOff(
  values: Float32Array,
  frame: ContributionFrame,
  crop: IslandCrop,
  recess: TerrainSettings["recess"]
): void {
  const reach = recess.clearance + recess.width;
  const offset = {
    column: crop.column - frame.column,
    row: crop.row - frame.row,
  };
  const span = overlap(crop, offset, frame, reach);
  for (let r = span.top; r < span.bottom; r += 1) {
    for (let c = span.left; c < span.right; c += 1) {
      const distance = crop.sdf[r * crop.width + c] ?? Number.POSITIVE_INFINITY;
      if (distance < reach) {
        const target = (r + offset.row) * frame.width + c + offset.column;
        values[target] =
          (values[target] ?? 0) * smoothstep(recess.clearance, reach, distance);
      }
    }
  }
}

/**
 * A relationship's influence on its members' crops: the probabilistic union
 * of each member's falloff, so overlapping members reinforce without
 * exceeding 1, then held off near every island outside the relationship.
 * No edge between members is drawn; continuity only forms where their lobes
 * actually meet.
 */
function contributionField(
  source: TerrainContributionSource,
  crops: ReadonlyMap<string, IslandCrop>,
  grid: { cell: number; height: number; width: number },
  settings: TerrainSettings
): TerrainContribution | undefined {
  const members = source.members.flatMap((member) => {
    const crop = crops.get(member.territoryId);
    return crop && member.amplitude > 0 ? [{ crop, member }] : [];
  });
  if (!members.length) {
    return;
  }
  const profile =
    source.kind === "internal" ? settings.basement : settings.shelf;
  const column = Math.max(
    0,
    Math.min(...members.map(({ crop }) => crop.column))
  );
  const row = Math.max(0, Math.min(...members.map(({ crop }) => crop.row)));
  const right = Math.min(
    grid.width,
    Math.max(...members.map(({ crop }) => crop.column + crop.width))
  );
  const bottom = Math.min(
    grid.height,
    Math.max(...members.map(({ crop }) => crop.row + crop.height))
  );
  const width = Math.max(0, right - column);
  const height = Math.max(0, bottom - row);
  if (!(width && height)) {
    return;
  }
  const frame = { cell: grid.cell, column, height, row, width };
  const complement = new Float32Array(width * height).fill(1);
  const prominence = source.members.length - 1;
  for (const { crop, member } of members) {
    const lobe = member.supplier
      ? {
          ...profile,
          plateau: profile.plateau + supplierExtent(prominence, settings),
        }
      : profile;
    unionLobe(complement, frame, crop, member.amplitude, lobe);
  }
  const values = Float32Array.from(complement, (value) => 1 - value);
  const memberIds = new Set(source.members.map((member) => member.territoryId));
  for (const [id, crop] of crops) {
    if (!memberIds.has(id)) {
      holdOff(values, frame, crop, settings.recess);
    }
  }
  return { column, height, row, source, values, width };
}

/** Thickness by band, then elevation: basement from the abyss, shelves on it, coasts above both. */
function composeSurface(
  contributions: readonly TerrainContribution[],
  signedDistance: Float32Array,
  grid: { height: number; width: number },
  settings: TerrainSettings
): TerrainSurface {
  const size = grid.width * grid.height;
  const shelf = new Float32Array(size);
  const basement = new Float32Array(size);
  for (const contribution of contributions) {
    const band = contribution.source.kind === "internal" ? basement : shelf;
    const { weight } = contribution.source;
    eachCell(contribution, grid.width, grid.height, (local, global) => {
      band[global] =
        (band[global] ?? 0) + weight * (contribution.values[local] ?? 0);
    });
  }
  const { abyss, basementTop, land, shelfTop, waterLevel } = terrainLevels;
  const elevation = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    const distance = signedDistance[index] ?? Number.POSITIVE_INFINITY;
    if (distance < 0) {
      elevation[index] =
        waterLevel +
        (land - waterLevel) * Math.min(1, -distance / settings.land);
      continue;
    }
    const base =
      abyss +
      (basementTop - abyss) *
        saturate(basement[index] ?? 0, settings.basementHalf);
    const structure =
      base +
      (shelfTop - base) * saturate(shelf[index] ?? 0, settings.shelfHalf);
    const descent =
      waterLevel +
      (abyss - waterLevel) * (1 - falloff(distance, settings.coast));
    // The smoothing never lifts the shelves to the coast: they stay
    // `waterLevel - shelfTop` below it, more than the smoothing width.
    elevation[index] = Math.min(
      waterLevel,
      smoothMax(descent, structure, settings.smoothing)
    );
  }
  return { basement, elevation, shelf };
}

/** Water over the terrain at `level`: 0 on land. */
export function waterDepth(
  surface: Pick<TerrainSurface, "elevation">,
  level: number = terrainLevels.waterLevel
): Float32Array {
  return Float32Array.from(surface.elevation, (elevation) =>
    Math.max(0, level - elevation)
  );
}

/** The terrain read as land at `level`: what is above it, and how high. */
export function landReading(
  surface: Pick<TerrainSurface, "elevation">,
  level: number
): Float32Array {
  const span = terrainLevels.land - level;
  return Float32Array.from(surface.elevation, (elevation) =>
    elevation > level ? (elevation - level) / span : 0
  );
}

/** Lift above the abyss, 0 to 1 at the water level and above. */
export function terrainLift(elevation: number): number {
  const { abyss, waterLevel } = terrainLevels;
  return Math.min(1, Math.max(0, (elevation - abyss) / (waterLevel - abyss)));
}

/** Contours of a grid-shaped field in map units, holes and separate pieces kept. */
function fieldContours(
  terrain: Pick<StructuralTerrain, "cell" | "left" | "top">,
  values: ArrayLike<number>,
  size: { column: number; height: number; row: number; width: number },
  thresholds: readonly number[]
): Polygon[][] {
  return contours()
    .size([size.width, size.height])
    .thresholds([...thresholds])(values as number[])
    .map((contour) =>
      contour.coordinates.map((polygon) =>
        polygon.map((ring) =>
          ring.map(([x = 0, y = 0]): [number, number] => [
            terrain.left + (size.column + x) * terrain.cell,
            terrain.top + (size.row + y) * terrain.cell,
          ])
        )
      )
    );
}

/**
 * The outer silhouette of the whole formation: where the terrain rises
 * `silhouetteLift` above the abyss. Separate formations stay separate and
 * enclosed deep water stays a hole. It is an underwater contour, not a coast.
 */
export function terrainSilhouette(
  terrain: StructuralTerrain,
  surface: TerrainSurface = terrain.surface
): Polygon[] {
  const lift = Float32Array.from(surface.elevation, terrainLift);
  return (
    fieldContours(
      terrain,
      lift,
      { column: 0, height: terrain.height, row: 0, width: terrain.width },
      [terrain.settings.silhouetteLift]
    )[0] ?? []
  );
}

/** One contribution's own boundary, where its influence is `level`. */
export function contributionBoundary(
  terrain: StructuralTerrain,
  contribution: TerrainContribution,
  level = 0.5
): Polygon[] {
  return (
    fieldContours(terrain, contribution.values, contribution, [level])[0] ?? []
  );
}

/** Elevation contours at each level given, deepest first, from the terrain itself. */
export function depthContours(
  terrain: StructuralTerrain,
  levels: readonly number[],
  surface: TerrainSurface = terrain.surface
): Polygon[][] {
  return fieldContours(
    terrain,
    surface.elevation,
    { column: 0, height: terrain.height, row: 0, width: terrain.width },
    [...levels].sort((a, b) => a - b)
  );
}

/** A field's value at a map position, by its nearest cell; outside the grid, `outside`. */
export function terrainAt(
  terrain: Pick<
    StructuralTerrain,
    "cell" | "height" | "left" | "top" | "width"
  >,
  values: ArrayLike<number>,
  x: number,
  y: number,
  outside = Number.NaN
): number {
  const column = Math.floor((x - terrain.left) / terrain.cell);
  const row = Math.floor((y - terrain.top) / terrain.cell);
  if (
    column < 0 ||
    row < 0 ||
    column >= terrain.width ||
    row >= terrain.height
  ) {
    return outside;
  }
  return values[row * terrain.width + column] ?? outside;
}

/** A contribution's influence at a map position: 0 outside its crop. */
export function contributionAt(
  terrain: Pick<StructuralTerrain, "cell" | "left" | "top">,
  contribution: TerrainContribution,
  x: number,
  y: number
): number {
  return terrainAt(
    {
      cell: terrain.cell,
      height: contribution.height,
      left: terrain.left + contribution.column * terrain.cell,
      top: terrain.top + contribution.row * terrain.cell,
      width: contribution.width,
    },
    contribution.values,
    x,
    y,
    0
  );
}
