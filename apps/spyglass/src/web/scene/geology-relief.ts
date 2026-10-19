import type { GeologyGrid } from "../../lib/visualization/geology";
import { fbm, noiseSeed } from "../../lib/visualization/noise";
import type { WorldTerrain } from "../../lib/visualization/world-terrain";
import type { GeologyLattice } from "../layout/geology-lattice";

/**
 * The terrain's relief baked once per build, on the CPU: ambient occlusion
 * from cavity, sun visibility from a horizon toward the sun, the seabed's
 * curvature and a low mottling field. Every field is computed on the world
 * grid, where the seabed is as fine as it is, and each lattice vertex reads
 * it bilinearly against its own elevation, so a refined coast still darkens
 * at its foot. The work is a summed-area table, a few box means and a short
 * march toward the sun: linear in the grid and the vertices.
 */
export interface ReliefSettings {
  /**
   * Cavity occlusion: how far the mean elevation within each radius stands
   * over a vertex, as a slope of exaggerated height over map units. `gain`
   * turns that slope into occlusion, `strength` is the most a crease loses
   * of its sky light, and `radii` are in map units, each weighed equally.
   */
  cavity: { gain: number; radii: readonly number[]; strength: number };
  /**
   * Low-frequency mottling of the seabed's albedo: map units per noise
   * cell and the fBm's octaves. The bake writes it in -1 to 1; the albedo
   * decides how much it shows.
   */
  mottle: { octaves: number; seed: string; wavelength: number };
  /**
   * Self-shadow: the steepest horizon toward the sun over these map-unit
   * distances. A vertex whose horizon stands over the sun's elevation is in
   * shade, softened over `softness` of slope either side, and loses
   * `strength` of its sunlight.
   */
  shadow: { distances: readonly number[]; softness: number; strength: number };
}

/** Something tall the bake stands on the field: a sea stack's footprint and top. */
export interface ReliefStamp {
  /** Elevation of the top, in `geologyLevels` units. */
  height: number;
  /** Map units of the footprint's radius. */
  radius: number;
  x: number;
  y: number;
}

/** The bake's output, one value or pair a lattice vertex. */
export interface Relief {
  /**
   * Each vertex's curvature: how far the mean elevation around it stands
   * over it, averaged over the cavity's radii, in elevation units:
   * positive in a hollow or at a riser's foot, negative on a crest or lip.
   */
  curvature: Float32Array;
  /**
   * Each vertex's elevation gradient per map unit, x then y, for light and
   * albedo: the lattice's on land, the seabed's at a cell's span under
   * water.
   */
  gradient: Float32Array;
  /** Each vertex's mottling, -1 to 1. */
  mottle: Float32Array;
  /**
   * Each vertex's light, two a vertex: the share of the sky it sees, then
   * the share of the sun, each 0 to 1.
   */
  occlusion: Float32Array;
}

/** The sun as the bake reads it: its bearing on the map and the slope of its elevation. */
export interface ReliefSun {
  /** The map direction toward the sun, x right and y down the chart, unit length. */
  bearing: readonly [number, number];
  /** Rise over run toward the sun: the tangent of its elevation. */
  slope: number;
}

/** A world-space light direction, x right, y up the chart and z up, as the bake reads it. */
export function reliefSun(direction: {
  x: number;
  y: number;
  z: number;
}): ReliefSun {
  const run = Math.hypot(direction.x, direction.y);
  if (run < 1e-9) {
    return { bearing: [0, 0], slope: Number.POSITIVE_INFINITY };
  }
  // World y is map y turned over.
  return {
    bearing: [direction.x / run, -direction.y / run],
    slope: direction.z / run,
  };
}

/** The world field with each stamp's top stood over its footprint. */
function stampedElevation(
  world: ReliefField,
  stamps: readonly ReliefStamp[]
): Float32Array {
  const elevation = Float32Array.from(world.elevation);
  const { cell, height, left, top, width } = world;
  for (const stamp of stamps) {
    const reach = Math.ceil(stamp.radius / cell);
    const column = Math.round((stamp.x - left) / cell - 0.5);
    const row = Math.round((stamp.y - top) / cell - 0.5);
    for (let r = row - reach; r <= row + reach; r += 1) {
      for (let c = column - reach; c <= column + reach; c += 1) {
        const x = left + (c + 0.5) * cell;
        const y = top + (r + 0.5) * cell;
        const inside =
          Math.hypot(x - stamp.x, y - stamp.y) <= stamp.radius + cell / 2;
        if (inside && c >= 0 && r >= 0 && c < width && r < height) {
          const at = r * width + c;
          elevation[at] = Math.max(elevation[at] ?? 0, stamp.height);
        }
      }
    }
  }
  return elevation;
}

/** The mean of a field over a square of side `2·reach + 1` cells at every cell, clamped to the grid, from a summed-area table. */
function boxMeans(
  values: Float32Array,
  width: number,
  height: number,
  reaches: readonly number[]
): Float32Array[] {
  const stride = width + 1;
  const table = new Float64Array(stride * (height + 1));
  for (let row = 0; row < height; row += 1) {
    let sum = 0;
    for (let column = 0; column < width; column += 1) {
      sum += values[row * width + column] ?? 0;
      table[(row + 1) * stride + column + 1] =
        (table[row * stride + column + 1] ?? 0) + sum;
    }
  }
  return reaches.map((reach) => {
    const means = new Float32Array(width * height);
    for (let row = 0; row < height; row += 1) {
      const top = Math.max(0, row - reach);
      const bottom = Math.min(height, row + reach + 1);
      for (let column = 0; column < width; column += 1) {
        const left = Math.max(0, column - reach);
        const right = Math.min(width, column + reach + 1);
        const sum =
          (table[bottom * stride + right] ?? 0) -
          (table[top * stride + right] ?? 0) -
          (table[bottom * stride + left] ?? 0) +
          (table[top * stride + left] ?? 0);
        means[row * width + column] = sum / ((bottom - top) * (right - left));
      }
    }
    return means;
  });
}

/**
 * A grid's bilinear reader between cell centres, clamped to its edge: `place`
 * finds a map position's cell and weights once, and `read` blends any field
 * of the grid there, so several fields at one position cost one placement.
 */
class GridReader {
  private at = 0;
  private s = 0;
  private t = 0;
  private readonly cell: number;
  private readonly height: number;
  private readonly left: number;
  private readonly top: number;
  private readonly width: number;

  constructor(grid: GeologyGrid) {
    this.cell = grid.cell;
    this.height = grid.height;
    this.left = grid.left;
    this.top = grid.top;
    this.width = grid.width;
  }

  /** Places the reader at a map position, for `read`. */
  place(x: number, y: number): void {
    const u = Math.min(
      this.width - 1,
      Math.max(0, (x - this.left) / this.cell - 0.5)
    );
    const v = Math.min(
      this.height - 1,
      Math.max(0, (y - this.top) / this.cell - 0.5)
    );
    const column = Math.min(this.width - 2, Math.floor(u));
    const row = Math.min(this.height - 2, Math.floor(v));
    this.s = u - column;
    this.t = v - row;
    this.at = row * this.width + column;
  }

  /** A field's value at the placed position. */
  read(values: Float32Array): number {
    const below = this.at + this.width;
    const north =
      (values[this.at] as number) * (1 - this.s) +
      (values[this.at + 1] as number) * this.s;
    const south =
      (values[below] as number) * (1 - this.s) +
      (values[below + 1] as number) * this.s;
    return north * (1 - this.t) + south * this.t;
  }
}

function smoothstep(from: number, to: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** Mottling cells a wavelength: fine enough that bilinear reads of it look like the noise itself. */
const mottleCellsPerWavelength = 8;

/**
 * The mottling field over a grid's extent, -1 to 1, on a grid of its own
 * at `mottleCellsPerWavelength` cells a wavelength: the field is low, so a
 * coarse grid read bilinearly holds it, at a small share of the cost.
 */
function mottleField(
  extent: GeologyGrid,
  settings: ReliefSettings["mottle"]
): { field: Float32Array; grid: GeologyGrid } {
  const cell = Math.max(
    extent.cell,
    settings.wavelength / mottleCellsPerWavelength
  );
  const grid: GeologyGrid = {
    cell,
    height: Math.ceil((extent.height * extent.cell) / cell) + 1,
    left: extent.left,
    top: extent.top,
    width: Math.ceil((extent.width * extent.cell) / cell) + 1,
  };
  const { height, left, top, width } = grid;
  const field = new Float32Array(width * height);
  const seed = noiseSeed(settings.seed);
  const fractal = { gain: 0.5, lacunarity: 2, octaves: settings.octaves };
  for (let row = 0; row < height; row += 1) {
    const y = (top + (row + 0.5) * cell) / settings.wavelength;
    for (let column = 0; column < width; column += 1) {
      const x = (left + (column + 0.5) * cell) / settings.wavelength;
      field[row * width + column] = fbm(x, y, seed, fractal);
    }
  }
  return { field, grid };
}

/** The world field as the bake reads it. */
export type ReliefField = Pick<
  WorldTerrain,
  "cell" | "elevation" | "height" | "left" | "signedDistance" | "top" | "width"
>;

type Vertices = Pick<
  GeologyLattice,
  "count" | "elevation" | "gradient" | "points"
>;

/**
 * Each vertex's sky share into `occlusion`'s even slots and its curvature
 * into `curvature`. The mean elevation within each radius is kept in two
 * parts, the seabed's and what stands over it (land and stamps), so a
 * vertex under water multiplies only the seabed's part by `seabedRelief`,
 * as the light multiplies the seabed's slope, and an island beside it
 * darkens it no more than its true height does. Curvature is the seabed's
 * part alone under water, so an island's ring is no hollow. `slopes` turn
 * each radius's rise to occlusion.
 */
function cavityPass(
  vertices: Vertices,
  reader: GridReader,
  means: { land: readonly Float32Array[]; seabed: readonly Float32Array[] },
  options: {
    seabedRelief: number;
    slopes: readonly number[];
    strength: number;
  },
  out: { curvature: Float32Array; occlusion: Float32Array }
): void {
  const { count, elevation, points } = vertices;
  const { seabedRelief, slopes, strength } = options;
  const radii = means.seabed.length;
  for (let id = 0; id < count; id += 1) {
    const own = elevation[id] as number;
    const underwater = own < 0;
    const relief = underwater ? seabedRelief : 1;
    reader.place(points[id * 2] as number, points[id * 2 + 1] as number);
    let hollow = 0;
    let bowl = 0;
    for (let index = 0; index < radii; index += 1) {
      const seabed = reader.read(means.seabed[index] as Float32Array) - own;
      const over = reader.read(means.land[index] as Float32Array);
      bowl += underwater ? seabed : seabed + over;
      hollow += Math.min(
        1,
        Math.max(0, (seabed * relief + over) * (slopes[index] as number))
      );
    }
    out.curvature[id] = bowl / radii;
    out.occlusion[id * 2] = 1 - (strength * hollow) / radii;
  }
}

/**
 * Each vertex's gradient for light and albedo: on land and off the coast
 * the lattice's own, under water near a coast the seabed's by central
 * differences a whole cell either way.
 * The fine lattice's seabed is bilinear between the grid's cells, so its
 * own gradient steps at every cell's edge; a cell-wide difference of it is
 * continuous, and the seabed's light, its slope multiplied, does not stripe.
 */
function gradientPass(
  vertices: Vertices,
  reader: GridReader,
  seabed: Float32Array,
  world: ReliefField
): Float32Array {
  const { count, elevation, gradient, points } = vertices;
  const { cell, signedDistance } = world;
  const coarse = world.width * world.height;
  const values = Float32Array.from(gradient);
  for (let id = 0; id < count; id += 1) {
    // Coarse vertices off the coast already carry the field's own, cell-wide gradient.
    const offshore = id < coarse && (signedDistance[id] as number) >= 2 * cell;
    if (!offshore && (elevation[id] as number) < 0) {
      const x = points[id * 2] as number;
      const y = points[id * 2 + 1] as number;
      reader.place(x + cell, y);
      const east = reader.read(seabed);
      reader.place(x - cell, y);
      const west = reader.read(seabed);
      reader.place(x, y + cell);
      const south = reader.read(seabed);
      reader.place(x, y - cell);
      const north = reader.read(seabed);
      values[id * 2] = (east - west) / (2 * cell);
      values[id * 2 + 1] = (south - north) / (2 * cell);
    }
  }
  return values;
}

/**
 * Each vertex's sun share into `occlusion`'s odd slots: the steepest rise
 * toward the sun over `distances`, against the sun's own slope. As with the
 * cavity, a vertex under water multiplies the seabed's part of the rise by
 * `seabedRelief`, so a riser shades the tread below it, while an island
 * casts only as long a shadow as it truly stands.
 */
function horizonPass(
  vertices: Vertices,
  reader: GridReader,
  fields: { over: Float32Array; seabed: Float32Array },
  options: {
    exaggeration: number;
    seabedRelief: number;
    settings: ReliefSettings["shadow"];
    sun: ReliefSun;
  },
  occlusion: Float32Array
): void {
  const { count, elevation, points } = vertices;
  const { exaggeration, seabedRelief, settings, sun } = options;
  const [towardX, towardY] = sun.bearing;
  const distances = Float64Array.from(settings.distances);
  const steps = distances.length;
  const from = sun.slope - settings.softness;
  const to = sun.slope + settings.softness;
  for (let id = 0; id < count; id += 1) {
    const own = elevation[id] as number;
    const relief = own < 0 ? seabedRelief : 1;
    const x = points[id * 2] as number;
    const y = points[id * 2 + 1] as number;
    let horizon = Number.NEGATIVE_INFINITY;
    // Indexed rather than for...of: over 400k vertices it measures a third faster.
    for (let step = 0; step < steps; step += 1) {
      const distance = distances[step] as number;
      reader.place(x + towardX * distance, y + towardY * distance);
      const rise =
        (reader.read(fields.seabed) - own) * relief + reader.read(fields.over);
      horizon = Math.max(horizon, (rise * exaggeration) / distance);
    }
    occlusion[id * 2 + 1] =
      1 - settings.strength * smoothstep(from, to, horizon);
  }
}

/** Each vertex's value of a grid field, bilinear. */
function samplePass(
  vertices: Vertices,
  reader: GridReader,
  field: Float32Array
): Float32Array {
  const { count, points } = vertices;
  const values = new Float32Array(count);
  for (let id = 0; id < count; id += 1) {
    reader.place(points[id * 2] as number, points[id * 2 + 1] as number);
    values[id] = reader.read(field);
  }
  return values;
}

/**
 * The relief of the lattice's terrain under a sun: occlusion from the world
 * field's cavities at each radius, the sun's visibility over its horizon,
 * curvature over the same radii and the mottling field. `stamps` stand
 * on the field for the bake only, so the seabed darkens round a sea stack's
 * foot and takes its shadow. The seabed's gradient is smoothed over a cell
 * for its light. Heights are exaggerated as the mesh's are,
 * and the seabed's own relief further by `seabedRelief` in both the cavity
 * and the horizon; what stands over the seabed keeps the mesh's heights, so
 * an island's shadow is as long as it stands.
 */
export function bakeRelief(options: {
  exaggeration: number;
  lattice: Vertices;
  /**
   * How far the light multiplies the seabed's slope, as
   * `TerrainLightSettings.relief.seabed`: the seabed's cavities deepen by
   * the same factor, so its creases darken as its slopes shade.
   */
  seabedRelief?: number;
  settings: ReliefSettings;
  stamps?: readonly ReliefStamp[];
  sun: ReliefSun;
  world: ReliefField;
}): Relief {
  const { exaggeration, lattice, settings, stamps = [], sun, world } = options;
  const elevation = stampedElevation(world, stamps);
  // The seabed meets every coast at the water level, as the lattice's does.
  const seabed = Float32Array.from(world.elevation, (value, at) =>
    (world.signedDistance[at] ?? 0) < 0 ? 0 : Math.min(0, value)
  );
  // What stands over the seabed, softened by a cell: the grid's land is a
  // staircase of whole cells, which would print on the occlusion and shadow.
  const [over = new Float32Array(elevation.length)] = boxMeans(
    Float32Array.from(elevation, (value, at) => value - (seabed[at] ?? 0)),
    world.width,
    world.height,
    [1]
  );
  const radii = settings.cavity.radii.length
    ? settings.cavity.radii
    : [world.cell];
  const reaches = radii.map((radius) =>
    Math.max(1, Math.round(radius / world.cell))
  );
  const means = {
    land: boxMeans(over, world.width, world.height, reaches),
    seabed: boxMeans(seabed, world.width, world.height, reaches),
  };
  // Occlusion per elevation unit the surroundings stand over a vertex, by radius.
  const slopes = radii.map(
    (radius) => (exaggeration * settings.cavity.gain) / radius
  );
  const reader = new GridReader(world);
  const occlusion = new Float32Array(lattice.count * 2);
  const curvature = new Float32Array(lattice.count);
  cavityPass(
    lattice,
    reader,
    means,
    {
      seabedRelief: options.seabedRelief ?? 1,
      slopes,
      strength: settings.cavity.strength,
    },
    { curvature, occlusion }
  );
  horizonPass(
    lattice,
    reader,
    { over, seabed },
    {
      exaggeration,
      seabedRelief: options.seabedRelief ?? 1,
      settings: settings.shadow,
      sun,
    },
    occlusion
  );
  const mottled = mottleField(world, settings.mottle);
  const mottle = samplePass(
    lattice,
    new GridReader(mottled.grid),
    mottled.field
  );
  return {
    curvature,
    gradient: gradientPass(lattice, reader, seabed, world),
    mottle,
    occlusion,
  };
}
