import { contours } from "d3-contour";
import { shoreDistances } from "./distance-field";
import { fillPolygon } from "./scanline-fill";
import type {
  DependencyFoundation,
  FoundationGroup,
  InternalFoundation,
  Polygon,
} from "./types";

export const terrainLevels = {
  abyss: -1,
  basementTop: -0.6,
  land: 1,
  shelfTop: -0.14,
  waterLevel: 0,
} as const;

export interface FalloffProfile {
  exponent: number;
  plateau: number;
  width: number;
}

export const defaultTerrainSettings = {
  basement: { exponent: 1.6, plateau: 30, width: 80 },
  basementHalf: 8,
  cell: 4,
  coast: { exponent: 1, plateau: 0, width: 24 },
  dependentShare: 0.5,
  land: 40,
  recess: { clearance: 12, width: 30 },
  shelf: { exponent: 2.4, plateau: 26, width: 48 },
  shelfHalf: 4,
  silhouetteLift: 0.1,
  smoothing: 0.08,
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

export interface TerrainContributionSource {
  dependencyIds: readonly string[];
  id: string;
  kind: "internal" | "shared";
  members: readonly {
    amplitude: number;
    supplier?: boolean;
    territoryId: string;
  }[];
  weight: number;
}

export interface TerrainInput {
  contributions: readonly TerrainContributionSource[];
  extent: { height: number; width: number };
  islands: readonly TerrainIsland[];
}

export interface TerrainContribution {
  column: number;
  height: number;
  row: number;
  source: TerrainContributionSource;
  values: Float32Array;
  width: number;
}

export interface TerrainSurface {
  basement: Float32Array;
  elevation: Float32Array;
  shelf: Float32Array;
}

export interface StructuralTerrain {
  cell: number;
  compose(options?: { focus?: string; foundations?: boolean }): TerrainSurface;
  contributions: readonly TerrainContribution[];
  height: number;
  key: string;
  left: number;
  settings: TerrainSettings;
  signedDistance: Float32Array;
  surface: TerrainSurface;
  top: number;
  width: number;
}

interface IslandCrop {
  coast: { bottom: number; left: number; right: number; top: number };
  column: number;
  height: number;
  row: number;
  sdf: Float32Array;
  width: number;
}

const negligible = 0.002;

export function falloff(distance: number, profile: FalloffProfile): number {
  const beyond = distance - profile.plateau;
  if (beyond <= 0) {
    return 1;
  }
  return Math.exp(
    -((beyond / Math.max(profile.width, 1e-6)) ** profile.exponent)
  );
}

function falloffReach(profile: FalloffProfile): number {
  return (
    profile.plateau +
    profile.width * Math.log(1 / negligible) ** (1 / profile.exponent)
  );
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

function smoothMax(a: number, b: number, k: number): number {
  const highest = Math.max(a, b);
  if (k <= 0) {
    return highest;
  }
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return highest + ((h * h * k) / 4) * terrainLift(highest);
}

function saturate(thickness: number, half: number): number {
  return thickness > 0 ? thickness / (thickness + half) : 0;
}

function supplierExtent(prominence: number, settings: TerrainSettings) {
  return (settings.supplierReach * prominence) / (prominence + 3);
}

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
const cacheEntries = 2;

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

function fallbackCoast(radius: number): Polygon[] {
  const ring: [number, number][] = Array.from({ length: 32 }, (_, i) => [
    Math.cos((i * Math.PI) / 16) * radius,
    Math.sin((i * Math.PI) / 16) * radius,
  ]);
  return [[ring]];
}

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

interface ContributionFrame {
  cell: number;
  column: number;
  height: number;
  row: number;
  width: number;
}

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
    elevation[index] = Math.min(
      waterLevel,
      smoothMax(descent, structure, settings.smoothing)
    );
  }
  return { basement, elevation, shelf };
}

export function waterDepth(
  surface: Pick<TerrainSurface, "elevation">,
  level: number = terrainLevels.waterLevel
): Float32Array {
  return Float32Array.from(surface.elevation, (elevation) =>
    Math.max(0, level - elevation)
  );
}

export function landReading(
  surface: Pick<TerrainSurface, "elevation">,
  level: number
): Float32Array {
  const span = terrainLevels.land - level;
  return Float32Array.from(surface.elevation, (elevation) =>
    elevation > level ? (elevation - level) / span : 0
  );
}

function terrainLift(elevation: number): number {
  const { abyss, waterLevel } = terrainLevels;
  return Math.min(1, Math.max(0, (elevation - abyss) / (waterLevel - abyss)));
}

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

export function contributionBoundary(
  terrain: StructuralTerrain,
  contribution: TerrainContribution,
  level = 0.5
): Polygon[] {
  return (
    fieldContours(terrain, contribution.values, contribution, [level])[0] ?? []
  );
}

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
