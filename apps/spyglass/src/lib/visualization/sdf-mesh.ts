/**
 * Triangles from a signed distance function, for the SDF trial: naive
 * surface nets and dual contouring over one sample lattice, meshed chunk
 * by chunk. Both place one vertex in every lattice cell the surface passes
 * through and join the four cells round every lattice edge it crosses with
 * a quad, so they share their topology and differ only in where a cell's
 * vertex goes:
 *
 * - **Surface nets** average the cell's edge crossings and step the point
 *   onto the surface. A crease is rounded over a cell.
 * - **Dual contouring** solves the least-squares point closest to every
 *   crossing's tangent plane (its position and the field's normal there),
 *   damping the directions the planes leave free and clamping the point
 *   to its cell, so a cell a terrace lip runs through puts its vertex on
 *   the lip.
 *
 * Both lean on the field being a true distance near its surface, gradient
 * length close to 1: the coarse pass skips a sample whose coarse neighbour
 * reads further from the surface than the lattice could carry it, and a
 * vertex steps onto the surface by its distance along the normal.
 *
 * Coordinates are whatever the field's are: the trial meshes in world
 * units, z up, so each triangle winds anticlockwise seen from outside.
 */

import { kernelQefOffset, qefRidge } from "./sdf-kernel";
import { numberMath } from "./terrain-kernel";

/** A signed distance: negative inside the solid. */
export interface SdfField {
  distance(x: number, y: number, z: number): number;
}

type Vec3 = [number, number, number];

/** The sample lattice: `size` samples along each axis from `origin`, `spacing` apart. */
export interface SdfLattice {
  origin: readonly [number, number, number];
  size: readonly [number, number, number];
  spacing: number;
}

export type SdfMeshMethod = "dual-contouring" | "surface-nets";

export interface SdfMeshOptions {
  /** Lattice cells along a chunk's side. */
  chunk: number;
  method: SdfMeshMethod;
  /**
   * Skip samples far from the surface by a coarse pass every 4 samples:
   * sound only for a field whose gradient length stays near or under 1.
   */
  skip: boolean;
}

/** One chunk's triangles: indexed, positions and unit normals three floats a vertex. */
export interface SdfMeshChunk {
  indices: Uint32Array;
  normals: Float32Array;
  positions: Float32Array;
}

export interface SdfMeshStats {
  /** Field evaluations, lattice samples and the solver's together. */
  evaluations: number;
  milliseconds: number;
  /** Lattice samples the coarse pass answered without evaluating the field. */
  skipped: number;
  triangles: number;
  vertices: number;
}

const defaultSdfMeshOptions: SdfMeshOptions = {
  chunk: 32,
  method: "dual-contouring",
  skip: true,
};

/** Share of a cell beyond its own faces a dual-contouring vertex may stand. */
const dualSlack = 0.5;

/** Coarse samples lie every `coarseStride` lattice samples. */
const coarseStride = 4;

/** Share of a lattice step the normals' central differences span. */
const normalStep = 0.02;

/** The eight corners of a cell as lattice offsets, x fastest. */
const cornerOffsets: readonly Vec3[] = Array.from(
  { length: 8 },
  (_, corner) => [
    corner % 2,
    Math.floor(corner / 2) % 2,
    Math.floor(corner / 4),
  ]
);

/** The twelve edges of a cell as pairs of corners. */
const cellEdges: readonly [number, number][] = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(
  (corner) =>
    [1, 2, 4]
      .filter((bit) => Math.floor(corner / bit) % 2 === 0)
      .map((bit): [number, number] => [corner, corner + bit])
);

/** The lattice's three axes as unit offsets. */
const axes: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** The field's gradient by central differences `step` apart. */
function sdfGradient(
  field: SdfField,
  x: number,
  y: number,
  z: number,
  step: number
): Vec3 {
  const twice = 2 * step;
  return [
    (field.distance(x + step, y, z) - field.distance(x - step, y, z)) / twice,
    (field.distance(x, y + step, z) - field.distance(x, y - step, z)) / twice,
    (field.distance(x, y, z + step) - field.distance(x, y, z - step)) / twice,
  ];
}

/** The mean of points three floats apiece. */
function massPoint(points: readonly number[]): Vec3 {
  const count = points.length / 3;
  const mass: Vec3 = [0, 0, 0];
  for (let index = 0; index < count; index += 1) {
    mass[0] += (points[index * 3] ?? 0) / count;
    mass[1] += (points[index * 3 + 1] ?? 0) / count;
    mass[2] += (points[index * 3 + 2] ?? 0) / count;
  }
  return mass;
}

/** The planes' normal equations about the mass point: `AᵀA` row-major and `Aᵀb`. */
function normalEquations(
  points: readonly number[],
  normals: readonly number[],
  mass: Vec3
): { ata: number[]; atb: Vec3 } {
  const ata = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const atb: Vec3 = [0, 0, 0];
  for (let index = 0; index < points.length / 3; index += 1) {
    const n: Vec3 = [
      normals[index * 3] ?? 0,
      normals[index * 3 + 1] ?? 0,
      normals[index * 3 + 2] ?? 0,
    ];
    // The plane's offset from the mass point.
    const b =
      n[0] * ((points[index * 3] ?? 0) - mass[0]) +
      n[1] * ((points[index * 3 + 1] ?? 0) - mass[1]) +
      n[2] * ((points[index * 3 + 2] ?? 0) - mass[2]);
    for (let row = 0; row < 3; row += 1) {
      atb[row] = (atb[row] ?? 0) + n[row as 0 | 1 | 2] * b;
      for (let column = 0; column < 3; column += 1) {
        ata[row * 3 + column] =
          (ata[row * 3 + column] ?? 0) +
          n[row as 0 | 1 | 2] * n[column as 0 | 1 | 2];
      }
    }
  }
  return { ata, atb };
}

/**
 * The point that best meets the tangent planes `(point, normal)`: the
 * least-squares solution about their mass point, regularised by a ridge
 * of `qefRidge` a plane (`kernelQefOffset`, the GPU's own solve), so a
 * flat patch keeps its vertex central and an edge or corner pulls it on.
 */
export function solveQef(
  points: readonly number[],
  normals: readonly number[]
): Vec3 {
  const mass = massPoint(points);
  const { ata, atb } = normalEquations(points, normals, mass);
  const offset = kernelQefOffset(
    numberMath,
    [
      ata[0] ?? 0,
      ata[1] ?? 0,
      ata[2] ?? 0,
      ata[4] ?? 0,
      ata[5] ?? 0,
      ata[8] ?? 0,
    ],
    atb,
    (qefRidge * points.length) / 3
  );
  return [mass[0] + offset[0], mass[1] + offset[1], mass[2] + offset[2]];
}

/** Lattice samples of the nodes a chunk reads. */
interface ChunkSamples {
  /** Lattice index of the block's first node on each axis. */
  from: Vec3;
  size: Vec3;
  values: Float32Array;
}

/**
 * The field at coarse lattice nodes, every `coarseStride` samples, each
 * evaluated once: a sample whose nearest coarse node reads further from the
 * surface than `reach` takes that node's value, its sign certain if the
 * field is a distance.
 */
function coarseSampler(
  field: SdfField,
  lattice: SdfLattice,
  stats: SdfMeshStats
) {
  const { origin, spacing } = lattice;
  const coarse = new Map<number, number>();
  return (i: number, j: number, k: number): number => {
    const ci = Math.round(i / coarseStride);
    const cj = Math.round(j / coarseStride);
    const ck = Math.round(k / coarseStride);
    const key = (ck * 4096 + cj) * 4096 + ci;
    const known = coarse.get(key);
    if (known !== undefined) {
      return known;
    }
    const value = field.distance(
      origin[0] + ci * coarseStride * spacing,
      origin[1] + cj * coarseStride * spacing,
      origin[2] + ck * coarseStride * spacing
    );
    stats.evaluations += 1;
    coarse.set(key, value);
    return value;
  };
}

/** Evaluates (or skips) every node from `from` to `to` inclusive. */
function sampleChunk(
  field: SdfField,
  lattice: SdfLattice,
  block: { from: Vec3; to: Vec3 },
  skip: boolean,
  stats: SdfMeshStats
): ChunkSamples {
  const { from, to } = block;
  const size: Vec3 = [
    to[0] - from[0] + 1,
    to[1] - from[1] + 1,
    to[2] - from[2] + 1,
  ];
  const [sx, sy, sz] = size;
  const values = new Float32Array(sx * sy * sz);
  const { origin, spacing } = lattice;
  // No surface lies within a lattice step of a sample further than this
  // from its coarse node's surface, if the field is a distance.
  const reach = spacing * (Math.sqrt(3) * (coarseStride / 2) + 1.5);
  const coarseAt = coarseSampler(field, lattice, stats);
  const sample = (gi: number, gj: number, gk: number): number => {
    if (skip) {
      const near = coarseAt(gi, gj, gk);
      if (Math.abs(near) > reach) {
        stats.skipped += 1;
        return near;
      }
    }
    stats.evaluations += 1;
    return field.distance(
      origin[0] + gi * spacing,
      origin[1] + gj * spacing,
      origin[2] + gk * spacing
    );
  };
  for (let k = 0; k < sz; k += 1) {
    for (let j = 0; j < sy; j += 1) {
      for (let i = 0; i < sx; i += 1) {
        values[(k * sy + j) * sx + i] = sample(
          from[0] + i,
          from[1] + j,
          from[2] + k
        );
      }
    }
  }
  return { from, size, values };
}

/** Where the field crosses zero between two points, by false position on the field itself. */
function crossing(
  field: SdfField,
  a: Vec3,
  b: Vec3,
  ends: [number, number],
  stats: SdfMeshStats
): Vec3 {
  let [flo, fhi] = ends;
  let lo = 0;
  let hi = 1;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const share = Math.min(0.95, Math.max(0.05, flo / (flo - fhi)));
    const t = lo + (hi - lo) * share;
    const value = field.distance(...lerp3(a, b, t));
    stats.evaluations += 1;
    if (Math.abs(value) < 1e-7) {
      return lerp3(a, b, t);
    }
    if (value < 0 === flo < 0) {
      lo = t;
      flo = value;
    } else {
      hi = t;
      fhi = value;
    }
  }
  return lerp3(a, b, lo + ((hi - lo) * flo) / (flo - fhi));
}

/** Unit normal of the field at a point, by central differences. */
function unitNormal(
  field: SdfField,
  point: Vec3,
  step: number,
  stats: SdfMeshStats
): Vec3 {
  const [gx, gy, gz] = sdfGradient(field, ...point, step);
  stats.evaluations += 6;
  const length = Math.hypot(gx, gy, gz) || 1;
  return [gx / length, gy / length, gz / length];
}

/** A cell's corners: their lattice values and world positions. */
function cellCorners(
  lattice: SdfLattice,
  samples: ChunkSamples,
  cell: Vec3
): { positions: Vec3[]; values: number[] } {
  const { origin, spacing } = lattice;
  const [sx, sy] = samples.size;
  const positions: Vec3[] = [];
  const values: number[] = [];
  for (const [ox, oy, oz] of cornerOffsets) {
    const i = cell[0] + ox - samples.from[0];
    const j = cell[1] + oy - samples.from[1];
    const k = cell[2] + oz - samples.from[2];
    values.push(samples.values[(k * sy + j) * sx + i] ?? 0);
    positions.push([
      origin[0] + (cell[0] + ox) * spacing,
      origin[1] + (cell[1] + oy) * spacing,
      origin[2] + (cell[2] + oz) * spacing,
    ]);
  }
  return { positions, values };
}

/** Surface nets' vertex: the crossings' mean, stepped twice onto the surface, each step at most half a cell. */
function netVertex(
  field: SdfField,
  points: readonly number[],
  spacing: number,
  stats: SdfMeshStats
): Vec3 {
  const vertex = massPoint(points);
  for (let step = 0; step < 2; step += 1) {
    const d = field.distance(...vertex);
    const [gx, gy, gz] = sdfGradient(field, ...vertex, spacing * normalStep);
    stats.evaluations += 7;
    const length2 = gx * gx + gy * gy + gz * gz;
    if (length2 < 1e-12) {
      break;
    }
    const scale = Math.max(-spacing / 2, Math.min(spacing / 2, d)) / length2;
    vertex[0] -= gx * scale;
    vertex[1] -= gy * scale;
    vertex[2] -= gz * scale;
  }
  return vertex;
}

/** The vertex of one cell, or undefined where the surface misses it. */
function cellVertex(
  field: SdfField,
  lattice: SdfLattice,
  samples: ChunkSamples,
  cell: Vec3,
  method: SdfMeshMethod,
  stats: SdfMeshStats
): Vec3 | undefined {
  const { spacing } = lattice;
  const corners = cellCorners(lattice, samples, cell);
  const points: number[] = [];
  const normals: number[] = [];
  for (const [c0, c1] of cellEdges) {
    const v0 = corners.values[c0] ?? 0;
    const v1 = corners.values[c1] ?? 0;
    const a = corners.positions[c0];
    const b = corners.positions[c1];
    if (v0 < 0 === v1 < 0 || !a || !b) {
      continue;
    }
    if (method === "surface-nets") {
      points.push(...lerp3(a, b, v0 / (v0 - v1)));
    } else {
      const point = crossing(field, a, b, [v0, v1], stats);
      points.push(...point);
      normals.push(...unitNormal(field, point, spacing * normalStep, stats));
    }
  }
  if (points.length === 0) {
    return;
  }
  if (method === "surface-nets") {
    return netVertex(field, points, spacing, stats);
  }
  // A convex crease can pass through a cell none of whose edges it
  // crosses; the slack lets its neighbours' vertices reach it.
  const low = corners.positions[0] ?? [0, 0, 0];
  const slack = spacing * dualSlack;
  const solved = solveQef(points, normals);
  return [0, 1, 2].map((axis) =>
    Math.min(
      (low[axis] ?? 0) + spacing + slack,
      Math.max((low[axis] ?? 0) - slack, solved[axis] ?? 0)
    )
  ) as Vec3;
}

/** A chunk's sample block and cell vertices, indexed by cell. */
interface ChunkCells {
  high: Vec3;
  ids: Int32Array;
  low: Vec3;
  normals: number[];
  positions: number[];
  samples: ChunkSamples;
}

/** Whether a cell's corners disagree in sign, so the surface passes through it. */
function mixedCell(
  sampleAt: (i: number, j: number, k: number) => number,
  [i, j, k]: Vec3
): boolean {
  const first = sampleAt(i, j, k) < 0;
  return cornerOffsets.some(
    ([ox, oy, oz]) => sampleAt(i + ox, j + oy, k + oz) < 0 !== first
  );
}

/** The value of a chunk's sample at a lattice index. */
function chunkSampler(samples: ChunkSamples) {
  const [sx, sy] = samples.size;
  const [fx, fy, fz] = samples.from;
  return (i: number, j: number, k: number) =>
    samples.values[((k - fz) * sy + (j - fy)) * sx + (i - fx)] ?? 0;
}

/** Places the vertex of every cell from `low` to `high` (exclusive) the surface passes through. */
function placeVertices(
  field: SdfField,
  lattice: SdfLattice,
  block: { high: Vec3; low: Vec3 },
  options: SdfMeshOptions,
  stats: SdfMeshStats
): ChunkCells {
  const { high, low } = block;
  const samples = sampleChunk(
    field,
    lattice,
    { from: low, to: high },
    options.skip,
    stats
  );
  const [cx, cy, cz] = [high[0] - low[0], high[1] - low[1], high[2] - low[2]];
  const ids = new Int32Array(Math.max(0, cx * cy * cz)).fill(-1);
  const positions: number[] = [];
  const normals: number[] = [];
  const sampleAt = chunkSampler(samples);
  const [i0, j0, k0] = low;
  const [i1, j1, k1] = high;
  for (let k = k0; k < k1; k += 1) {
    for (let j = j0; j < j1; j += 1) {
      for (let i = i0; i < i1; i += 1) {
        const vertex = mixedCell(sampleAt, [i, j, k])
          ? cellVertex(
              field,
              lattice,
              samples,
              [i, j, k],
              options.method,
              stats
            )
          : undefined;
        if (vertex) {
          ids[((k - low[2]) * cy + (j - low[1])) * cx + (i - low[0])] =
            positions.length / 3;
          positions.push(...vertex);
          normals.push(
            ...unitNormal(field, vertex, lattice.spacing * normalStep, stats)
          );
        }
      }
    }
  }
  return { high, ids, low, normals, positions, samples };
}

/**
 * Joins the four cells round every lattice edge the chunk owns that the
 * surface crosses with a quad, split along the diagonal whose midpoint
 * lies nearer the surface, so a crease runs along a triangle's edge rather
 * than across it.
 */
function emitQuads(
  field: SdfField,
  lattice: SdfLattice,
  cells: ChunkCells,
  owned: { from: Vec3; to: Vec3 },
  stats: SdfMeshStats
): number[] {
  const { high, ids, low, positions } = cells;
  const [cx, cy] = [high[0] - low[0], high[1] - low[1]];
  const sampleAt = chunkSampler(cells.samples);
  const cellId = ([i, j, k]: Vec3) => {
    const outside =
      i < low[0] ||
      j < low[1] ||
      k < low[2] ||
      i >= high[0] ||
      j >= high[1] ||
      k >= high[2];
    return outside
      ? -1
      : (ids[((k - low[2]) * cy + (j - low[1])) * cx + (i - low[0])] ?? -1);
  };
  const vertexAt = (id: number): Vec3 => [
    positions[id * 3] ?? 0,
    positions[id * 3 + 1] ?? 0,
    positions[id * 3 + 2] ?? 0,
  ];
  const diagonalOff = (a: number, b: number) => {
    stats.evaluations += 1;
    return Math.abs(field.distance(...lerp3(vertexAt(a), vertexAt(b), 0.5)));
  };
  const indices: number[] = [];
  const quad = (q00: number, q10: number, q11: number, q01: number) => {
    if (diagonalOff(q00, q11) <= diagonalOff(q10, q01)) {
      indices.push(q00, q10, q11, q00, q11, q01);
    } else {
      indices.push(q00, q10, q01, q10, q11, q01);
    }
  };
  const [nx, ny, nz] = lattice.size;
  const edge = (node: Vec3, axis: number) => {
    const [dx, dy, dz] = axes[axis] ?? [0, 0, 0];
    const [i, j, k] = node;
    if (i + dx >= nx || j + dy >= ny || k + dz >= nz) {
      return;
    }
    const inside = sampleAt(i, j, k) < 0;
    if (sampleAt(i + dx, j + dy, k + dz) < 0 === inside) {
      return;
    }
    const [bx, by, bz] = axes[(axis + 1) % 3] ?? [0, 0, 0];
    const [ex, ey, ez] = axes[(axis + 2) % 3] ?? [0, 0, 0];
    const q00 = cellId([i - bx - ex, j - by - ey, k - bz - ez]);
    const q10 = cellId([i - ex, j - ey, k - ez]);
    const q11 = cellId([i, j, k]);
    const q01 = cellId([i - bx, j - by, k - bz]);
    if (Math.min(q00, q10, q11, q01) < 0) {
      return;
    }
    if (inside) {
      quad(q00, q10, q11, q01);
    } else {
      quad(q00, q01, q11, q10);
    }
  };
  const [i0, j0, k0] = owned.from;
  const [i1, j1, k1] = owned.to;
  for (let k = k0; k < k1; k += 1) {
    for (let j = j0; j < j1; j += 1) {
      for (let i = i0; i < i1; i += 1) {
        edge([i, j, k], 0);
        edge([i, j, k], 1);
        edge([i, j, k], 2);
      }
    }
  }
  return indices;
}

/**
 * One chunk: cells from `from` (inclusive) to `to` (exclusive) own the
 * lattice edges starting at their lowest corner; a quad round an owned
 * edge reads the cells behind it too, so the chunk places the vertices of
 * one more layer of cells below. Neighbouring chunks place those shared
 * vertices from the same samples, so their positions agree to the bit.
 */
function meshChunk(
  field: SdfField,
  lattice: SdfLattice,
  owned: { from: Vec3; to: Vec3 },
  options: SdfMeshOptions,
  stats: SdfMeshStats
): SdfMeshChunk | undefined {
  const { from, to } = owned;
  const low: Vec3 = [
    Math.max(0, from[0] - 1),
    Math.max(0, from[1] - 1),
    Math.max(0, from[2] - 1),
  ];
  const high: Vec3 = [
    Math.min(lattice.size[0] - 1, to[0]),
    Math.min(lattice.size[1] - 1, to[1]),
    Math.min(lattice.size[2] - 1, to[2]),
  ];
  if (high[0] <= low[0] || high[1] <= low[1] || high[2] <= low[2]) {
    return;
  }
  const cells = placeVertices(field, lattice, { high, low }, options, stats);
  const indices = emitQuads(field, lattice, cells, owned, stats);
  if (indices.length === 0) {
    return;
  }
  return {
    indices: Uint32Array.from(indices),
    normals: Float32Array.from(cells.normals),
    positions: Float32Array.from(cells.positions),
  };
}

/** Meshes a field over a lattice, chunk by chunk. Chunks that hold no surface are left out. */
export function meshSdf(
  field: SdfField,
  lattice: SdfLattice,
  options: SdfMeshOptions = defaultSdfMeshOptions
): { chunks: SdfMeshChunk[]; stats: SdfMeshStats } {
  const started = performance.now();
  const stats: SdfMeshStats = {
    evaluations: 0,
    milliseconds: 0,
    skipped: 0,
    triangles: 0,
    vertices: 0,
  };
  const [cx, cy, cz] = lattice.size.map((size) => size - 1) as Vec3;
  const chunks: SdfMeshChunk[] = [];
  const step = Math.max(1, options.chunk);
  for (let z = 0; z < cz; z += step) {
    for (let y = 0; y < cy; y += step) {
      for (let x = 0; x < cx; x += step) {
        const chunk = meshChunk(
          field,
          lattice,
          {
            from: [x, y, z],
            to: [
              Math.min(x + step, cx),
              Math.min(y + step, cy),
              Math.min(z + step, cz),
            ],
          },
          options,
          stats
        );
        if (chunk) {
          chunks.push(chunk);
          stats.triangles += chunk.indices.length / 3;
          stats.vertices += chunk.positions.length / 3;
        }
      }
    }
  }
  stats.milliseconds = performance.now() - started;
  return { chunks, stats };
}
