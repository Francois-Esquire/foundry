import { geologyLevels } from "../../lib/visualization/geology";
import type { IslandLandform } from "../../lib/visualization/landforms";
import {
  coastBins,
  coastDistance,
  coastSegments,
} from "../../lib/visualization/screen-terrain-coast";
import {
  defaultSdfIslandSettings,
  islandLattice,
  type SdfIsland,
  type SdfIslandSettings,
  sdfIsland,
  seabedElevation,
} from "../../lib/visualization/sdf-island";
import {
  meshSdf,
  type SdfMeshMethod,
  type SdfMeshStats,
} from "../../lib/visualization/sdf-mesh";
import type { WorldTerrain } from "../../lib/visualization/world-terrain";
import type { SpyglassData } from "../data/types";
import { type ChartWorld, chartWorld } from "./chart-world";

/**
 * The SDF trial's geometry on the CPU: two islands of the geology preview
 * (the deepest terraced plateau or volcano, and an atoll) as true signed
 * distances meshed by surface nets or dual contouring, each over a seabed
 * patch meshed as a height field, dense at the island and sparse offshore,
 * with the light each vertex takes baked in: the sky's share (occlusion),
 * the sun's (shadow) and the curvature the land's tone reads. Built once
 * per world, method and spacing, and cached.
 */

/** One mesh's arrays: positions and normals in world units, three floats a vertex; `shade` the sky, sun and curvature. */
export interface TrialMesh {
  indices: Uint32Array;
  normals: Float32Array;
  positions: Float32Array;
  shade: Float32Array;
}

/** One island's meshes and how they were built. */
interface TrialIsland {
  archetype: IslandLandform["archetype"];
  /** The island's SDF meshes, chunk by chunk. */
  chunks: TrialMesh[];
  /** World-unit bounds of the patch and the water over it: x right, y up. */
  extent: { bottom: number; left: number; right: number; top: number };
  id: string;
  mesh: SdfMeshStats;
  /** The seabed patch round the island. */
  patch: TrialMesh;
  sdf: SdfIsland;
  timings: {
    fieldsMs: number;
    lightMs: number;
    meshMs: number;
    patchMs: number;
    slabsMs: number;
  };
}

export interface SdfTrialSettings {
  island: SdfIslandSettings;
  method: SdfMeshMethod;
  patch: {
    /** Map units of seabed meshed past the island's field on every side. */
    offshore: number;
    /** World units the patch sinks under the island's field, so the island's own seabed covers it. */
    sink: number;
    /** Map units between patch vertices offshore, at most. */
    sparse: number;
  };
}

export const defaultSdfTrialSettings: SdfTrialSettings = {
  island: defaultSdfIslandSettings,
  method: "dual-contouring",
  patch: { offshore: 90, sink: 0.04, sparse: 4 },
};

/** The trial's islands for a chart: the deepest plateau, else volcano, and the deepest atoll, else another volcano. */
function trialIslandIds(
  landforms: ReadonlyMap<string, IslandLandform>
): string[] {
  const deepest = (archetype: string, not: readonly string[] = []) =>
    [...landforms]
      .filter(
        ([id, landform]) =>
          landform.archetype === archetype && !not.includes(id)
      )
      .sort(([, a], [, b]) => b.params.depth - a.params.depth)[0]?.[0];
  const terraced = deepest("plateau") ?? deepest("volcanic");
  const chosen = terraced ? [terraced] : [];
  const ring = deepest("atoll") ?? deepest("volcanic", chosen);
  return ring ? [...chosen, ring] : chosen;
}

/** World units of the sun's direction, as the preview's light. */
const sun = (() => {
  const x = -600;
  const y = 700;
  const z = 700;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length] as const;
})();

/** A height raster over the patch for the light: world heights, row 0 at the top of the chart. */
interface Raster {
  columns: number;
  heights: Float32Array;
  left: number;
  rows: number;
  spacing: number;
  /** World y of row 0. */
  top: number;
}

function rasterAt(raster: Raster, x: number, worldY: number): number {
  const u = (x - raster.left) / raster.spacing;
  const v = (raster.top - worldY) / raster.spacing;
  const column = Math.min(raster.columns - 2, Math.max(0, Math.floor(u)));
  const row = Math.min(raster.rows - 2, Math.max(0, Math.floor(v)));
  const s = Math.min(1, Math.max(0, u - column));
  const t = Math.min(1, Math.max(0, v - row));
  const at = (c: number, r: number) =>
    raster.heights[r * raster.columns + c] ?? 0;
  return (
    (at(column, row) * (1 - s) + at(column + 1, row) * s) * (1 - t) +
    (at(column, row + 1) * (1 - s) + at(column + 1, row + 1) * s) * t
  );
}

/** A box mean of the raster over `reach` samples each way, by a summed-area table. */
function rasterMean(raster: Raster, reach: number): Float32Array {
  const { columns, rows, heights } = raster;
  const stride = columns + 1;
  const table = new Float64Array(stride * (rows + 1));
  for (let row = 0; row < rows; row += 1) {
    let line = 0;
    for (let column = 0; column < columns; column += 1) {
      line += heights[row * columns + column] ?? 0;
      table[(row + 1) * stride + column + 1] =
        (table[row * stride + column + 1] ?? 0) + line;
    }
  }
  const means = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    const r0 = Math.max(0, row - reach);
    const r1 = Math.min(rows, row + reach + 1);
    for (let column = 0; column < columns; column += 1) {
      const c0 = Math.max(0, column - reach);
      const c1 = Math.min(columns, column + reach + 1);
      means[row * columns + column] =
        ((table[r1 * stride + c1] ?? 0) -
          (table[r0 * stride + c1] ?? 0) -
          (table[r1 * stride + c0] ?? 0) +
          (table[r0 * stride + c0] ?? 0)) /
        ((r1 - r0) * (c1 - c0));
    }
  }
  return means;
}

/** Map units beyond an island's field over which the patch's sink eases out. */
const sinkFade = 6;

/** Coordinates along one axis of the patch: dense near the field's edges, growing to `sparse` away from them. */
function axisLines(
  from: number,
  to: number,
  edges: readonly number[],
  dense: number,
  sparse: number
): number[] {
  const lines = new Set<number>([from, to]);
  for (const edge of edges) {
    for (const direction of [-1, 1]) {
      let at = edge;
      let step = dense;
      let walked = 0;
      while (at >= from && at <= to) {
        lines.add(Math.round(at * 1000) / 1000);
        walked += step;
        // Dense for six map units either side of the edge, then growing.
        if (walked > 6) {
          step = Math.min(sparse, step * 1.25);
        }
        at += direction * step;
      }
    }
  }
  return [...lines]
    .filter((value) => value >= from && value <= to)
    .sort((a, b) => a - b);
}

/** The world's seabed and every island's coast, for the patch beyond an island's field. */
function seabedSampler(world: WorldTerrain) {
  const segments = coastSegments(world.islands, world.islandIds);
  const bins = coastBins(world.islands, world.islandIds, segments, {
    cell: 8,
    height: Math.ceil((world.height * world.cell) / 8),
    left: world.left,
    top: world.top,
    width: Math.ceil((world.width * world.cell) / 8),
  });
  return (x: number, mapY: number) => {
    const coast = Math.min(
      coastDistance(bins, segments, x, mapY).distance,
      10_000
    );
    // Another island's land is left at the water level: the trial meshes only its two.
    return Math.min(
      geologyLevels.waterLevel,
      seabedElevation(world, Math.max(0, coast), x, mapY)
    );
  };
}

/** Whether a world (x, y) lies within an island's field, at least `inset` map units in. */
function withinField(
  sdf: SdfIsland,
  x: number,
  worldY: number,
  inset: number
): boolean {
  const { fields } = sdf;
  const mapY = -worldY;
  return (
    x >= fields.left + inset &&
    x <= fields.left + (fields.columns - 1) * fields.spacing - inset &&
    mapY >= fields.top + inset &&
    mapY <= fields.top + (fields.rows - 1) * fields.spacing - inset
  );
}

/** The sky's share at a point from a distance: how much of the surface stands within a few distances along its normal. */
function occlusion(
  distance: (x: number, y: number, z: number) => number,
  point: ArrayLike<number>,
  normal: ArrayLike<number>
): number {
  let lost = 0;
  let weights = 0;
  for (const [reach, weight] of [
    [0.6, 1],
    [1.5, 0.8],
    [3.5, 0.6],
    [7, 0.4],
  ] as const) {
    const d = distance(
      (point[0] ?? 0) + (normal[0] ?? 0) * reach,
      (point[1] ?? 0) + (normal[1] ?? 0) * reach,
      (point[2] ?? 0) + (normal[2] ?? 0) * reach
    );
    lost += weight * Math.min(1, Math.max(0, (reach - d) / reach));
    weights += weight;
  }
  return 1 - (0.85 * lost) / weights;
}

/** The sun's share at a point by marching a height raster toward the sun: soft, by how far any column stands over the ray. */
function rasterSun(raster: Raster, point: ArrayLike<number>): number {
  let worst = 0;
  let t = 0.6;
  while (t < 80) {
    const x = (point[0] ?? 0) + sun[0] * t;
    const y = (point[1] ?? 0) + sun[1] * t;
    const z = (point[2] ?? 0) + 0.05 + sun[2] * t;
    worst = Math.max(worst, (rasterAt(raster, x, y) - z) / (0.25 + 0.12 * t));
    t *= 1.12;
  }
  const s = Math.min(1, Math.max(0, worst));
  return 1 - s * s * (3 - 2 * s);
}

/** The sun's share by sphere tracing the island's own distance toward the sun: the classic soft shadow. */
function distanceSun(
  sdf: SdfIsland,
  point: ArrayLike<number>,
  normal: ArrayLike<number>
): number {
  const softness = 10;
  let shade = 1;
  let t = 0.15;
  const ox = (point[0] ?? 0) + (normal[0] ?? 0) * 0.05;
  const oy = (point[1] ?? 0) + (normal[1] ?? 0) * 0.05;
  const oz = (point[2] ?? 0) + (normal[2] ?? 0) * 0.05;
  for (let step = 0; step < 48 && t < 60; step += 1) {
    const x = ox + sun[0] * t;
    const y = oy + sun[1] * t;
    const z = oz + sun[2] * t;
    if (z > sdf.range.high || !withinField(sdf, x, y, 0)) {
      break;
    }
    const d = sdf.distance(x, y, z);
    shade = Math.min(shade, (softness * d) / t);
    if (shade < 0.01) {
      return 0;
    }
    t += Math.min(2, Math.max(0.08, d));
  }
  const s = Math.min(1, Math.max(0, shade));
  return s * s * (3 - 2 * s);
}

/** The curvature the land's tone and the seabed's sediment read: the raster's means round a point less its height, elevation units. */
function curvatureAt(
  raster: Raster,
  means: readonly Float32Array[],
  point: ArrayLike<number>,
  exaggeration: number
): number {
  const height = point[2] ?? 0;
  let sum = 0;
  for (const mean of means) {
    sum +=
      rasterAt({ ...raster, heights: mean }, point[0] ?? 0, point[1] ?? 0) -
      height;
  }
  return sum / means.length / exaggeration;
}

/** The light raster over a patch: the island's surface inside its field, the seabed beyond. */
function lightRaster(
  sdf: SdfIsland,
  extent: TrialIsland["extent"],
  seabed: (x: number, mapY: number) => number,
  exaggeration: number
): Raster {
  const spacing = 1;
  const columns = Math.ceil((extent.right - extent.left) / spacing) + 1;
  const rows = Math.ceil((extent.top - extent.bottom) / spacing) + 1;
  const heights = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    const y = extent.top - row * spacing;
    for (let column = 0; column < columns; column += 1) {
      const x = extent.left + column * spacing;
      heights[row * columns + column] = withinField(sdf, x, y, 0)
        ? sdf.surfaceHeight(x, y)
        : seabed(x, -y) * exaggeration;
    }
  }
  return {
    columns,
    heights,
    left: extent.left,
    rows,
    spacing,
    top: extent.top,
  };
}

/** Unit normals of a tensor grid's heights by central differences over its uneven spacing. */
function gridNormals(
  positions: Float32Array,
  xs: readonly number[],
  ys: readonly number[]
): Float32Array {
  const columns = xs.length;
  const rows = ys.length;
  const normals = new Float32Array(columns * rows * 3);
  const at = (column: number, row: number) =>
    positions[(row * columns + column) * 3 + 2] ?? 0;
  for (let row = 0; row < rows; row += 1) {
    const r0 = Math.max(0, row - 1);
    const r1 = Math.min(rows - 1, row + 1);
    for (let column = 0; column < columns; column += 1) {
      const c0 = Math.max(0, column - 1);
      const c1 = Math.min(columns - 1, column + 1);
      const gx =
        (at(c1, row) - at(c0, row)) / ((xs[c1] ?? 0) - (xs[c0] ?? 0) || 1);
      const gy =
        (at(column, r1) - at(column, r0)) /
        ((ys[r1] ?? 0) - (ys[r0] ?? 0) || 1);
      const length = Math.hypot(gx, gy, 1);
      normals.set(
        [-gx / length, -gy / length, 1 / length],
        (row * columns + column) * 3
      );
    }
  }
  return normals;
}

/**
 * Sinks a patch under an island's field once its normals are taken, so
 * the sink leaves no edge in the light: fully under the field, easing out
 * over `sinkFade` beyond it.
 */
function sinkUnder(
  sdf: SdfIsland,
  positions: Float32Array,
  xs: readonly number[],
  ys: readonly number[],
  sink: number
): void {
  const { fields } = sdf;
  const right = fields.left + (fields.columns - 1) * fields.spacing;
  const bottom = -(fields.top + (fields.rows - 1) * fields.spacing);
  const top = -fields.top;
  for (const [row, y] of ys.entries()) {
    const outsideY = Math.max(bottom - y, y - top, 0);
    for (const [column, x] of xs.entries()) {
      const outsideX = Math.max(fields.left - x, x - right, 0);
      const t = Math.min(1, Math.hypot(outsideX, outsideY) / sinkFade);
      const index = (row * xs.length + column) * 3 + 2;
      positions[index] =
        (positions[index] ?? 0) - sink * (1 - t * t * (3 - 2 * t));
    }
  }
}

/**
 * The seabed patch: a tensor grid, dense along the field's edges and
 * sparse offshore, standing on the island's own surface inside its field
 * (sunk a hair, so the island's mesh covers it) and the seabed beyond; the
 * quads deep inside the field, all hidden under the island, are dropped.
 */
function seabedPatch(
  sdf: SdfIsland,
  extent: TrialIsland["extent"],
  seabed: (x: number, mapY: number) => number,
  settings: SdfTrialSettings
): { normals: Float32Array; positions: Float32Array; indices: Uint32Array } {
  const X = settings.island.exaggeration;
  const { fields } = sdf;
  const fieldRight = fields.left + (fields.columns - 1) * fields.spacing;
  const fieldBottom = -(fields.top + (fields.rows - 1) * fields.spacing);
  const fieldTop = -fields.top;
  const xs = axisLines(
    extent.left,
    extent.right,
    [fields.left, fieldRight],
    fields.spacing,
    settings.patch.sparse
  );
  const ys = axisLines(
    extent.bottom,
    extent.top,
    [fieldBottom, fieldTop],
    fields.spacing,
    settings.patch.sparse
  );
  const columns = xs.length;
  const rows = ys.length;
  const positions = new Float32Array(columns * rows * 3);
  for (const [row, y] of ys.entries()) {
    for (const [column, x] of xs.entries()) {
      const z = withinField(sdf, x, y, 0)
        ? sdf.surfaceHeight(x, y)
        : seabed(x, -y) * X;
      positions.set([x, y, z], (row * columns + column) * 3);
    }
  }
  const normals = gridNormals(positions, xs, ys);
  sinkUnder(sdf, positions, xs, ys, settings.patch.sink);
  const indices: number[] = [];
  const hidden = (column: number, row: number) =>
    withinField(sdf, xs[column] ?? 0, ys[row] ?? 0, 3);
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      if (
        hidden(column, row) &&
        hidden(column + 1, row) &&
        hidden(column, row + 1) &&
        hidden(column + 1, row + 1)
      ) {
        continue;
      }
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      // Rows climb the world's y, so (a, b, d) winds anticlockwise from above.
      indices.push(a, b, d, a, d, c);
    }
  }
  return { indices: Uint32Array.from(indices), normals, positions };
}

/** Bakes each vertex's sky, sun and curvature into a `shade` array. */
function bakeShade(
  positions: Float32Array,
  normals: Float32Array,
  light: {
    curvature: (point: ArrayLike<number>) => number;
    sky: (point: ArrayLike<number>, normal: ArrayLike<number>) => number;
    sun: (point: ArrayLike<number>, normal: ArrayLike<number>) => number;
  }
): Float32Array {
  const count = positions.length / 3;
  const shade = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const point = positions.subarray(index * 3, index * 3 + 3);
    const normal = normals.subarray(index * 3, index * 3 + 3);
    shade[index * 3] = light.sky(point, normal);
    shade[index * 3 + 1] = light.sun(point, normal);
    shade[index * 3 + 2] = light.curvature(point);
  }
  return shade;
}

/** One island of the trial, from the chart's world. */
function buildTrialIsland(
  chart: ChartWorld,
  id: string,
  seabed: (x: number, mapY: number) => number,
  settings: SdfTrialSettings
): TrialIsland {
  const X = settings.island.exaggeration;
  const sdf = sdfIsland(chart.world, chart.landforms, id, settings.island);
  const lattice = islandLattice(sdf);
  const meshed = meshSdf(sdf, lattice, {
    chunk: 32,
    method: settings.method,
    skip: true,
  });
  const patchStarted = performance.now();
  const { fields } = sdf;
  const { offshore } = settings.patch;
  const extent = {
    bottom: -(fields.top + (fields.rows - 1) * fields.spacing) - offshore,
    left: fields.left - offshore,
    right: fields.left + (fields.columns - 1) * fields.spacing + offshore,
    top: -fields.top + offshore,
  };
  const patch = seabedPatch(sdf, extent, seabed, settings);
  const lightStarted = performance.now();
  const raster = lightRaster(sdf, extent, seabed, X);
  const means = [8, 16, 32].map((radius) =>
    rasterMean(raster, Math.round(radius / raster.spacing))
  );
  const curvature = (point: ArrayLike<number>) =>
    curvatureAt(raster, means, point, X);
  const rasterDistance = (x: number, y: number, z: number) =>
    z - rasterAt(raster, x, y);
  const chunks = meshed.chunks.map((chunk) => ({
    ...chunk,
    shade: bakeShade(chunk.positions, chunk.normals, {
      curvature,
      sky: (point, normal) => occlusion(sdf.distance, point, normal),
      // The island's own distance shadows it; the raster adds what stands beyond its field.
      sun: (point, normal) =>
        Math.min(distanceSun(sdf, point, normal), rasterSun(raster, point)),
    }),
  }));
  const patchMesh: TrialMesh = {
    ...patch,
    shade: bakeShade(patch.positions, patch.normals, {
      curvature,
      sky: (point, normal) => occlusion(rasterDistance, point, normal),
      sun: (point) => rasterSun(raster, point),
    }),
  };
  const done = performance.now();
  return {
    archetype: chart.landforms.get(id)?.archetype ?? "plateau",
    chunks,
    extent,
    id,
    mesh: meshed.stats,
    patch: patchMesh,
    sdf,
    timings: {
      fieldsMs: sdf.milliseconds.fields,
      lightMs: done - lightStarted,
      meshMs: meshed.stats.milliseconds,
      patchMs: lightStarted - patchStarted,
      slabsMs: sdf.milliseconds.slabs,
    },
  };
}

export interface SdfTrial {
  islands: TrialIsland[];
  key: string;
  timings: { chartMs: number; totalMs: number };
}

const cache = new Map<string, SdfTrial>();

/** The trial's islands for a chart, built once per world, method and spacing. */
export function buildSdfTrial(
  data: Parameters<typeof chartWorld>[0] & Pick<SpyglassData, "territories">,
  settings: SdfTrialSettings = defaultSdfTrialSettings
): SdfTrial {
  const started = performance.now();
  const chart = chartWorld(data);
  const charted = performance.now();
  const key = `${chart.world.key}|${settings.method}|${settings.island.spacing}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const seabed = seabedSampler(chart.world);
  const islands = trialIslandIds(chart.landforms).map((id) =>
    buildTrialIsland(chart, id, seabed, settings)
  );
  const trial: SdfTrial = {
    islands,
    key,
    timings: {
      chartMs: charted - started,
      totalMs: performance.now() - started,
    },
  };
  cache.set(key, trial);
  return trial;
}
