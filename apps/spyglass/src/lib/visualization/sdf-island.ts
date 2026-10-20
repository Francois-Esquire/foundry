import { elevationAtDepth, geologyLevels } from "./geology";
import {
  defaultLagoonSettings,
  inletChannel,
  type LagoonSettings,
} from "./lagoons";
import { defaultLandformSettings, type IslandLandform } from "./landforms";
import {
  coastBins,
  coastDistance,
  coastSegments,
} from "./screen-terrain-coast";
import {
  columnSlots,
  columnStride,
  kernelSlabField,
  packSlabProfile,
  type SlabProfile,
  slabCount,
} from "./sdf-kernel";
import type { SdfField } from "./sdf-mesh";
import { numberMath } from "./terrain-kernel";
import { islandSlots, packLandforms } from "./terrain-kernel-landform";
import { kernelTerrace } from "./terrain-kernel-terrace";
import {
  defaultWorldTerrainSettings,
  type WorldTerrain,
} from "./world-terrain";

/**
 * One island of the geology preview as a true 3D signed distance, for the
 * SDF trial: its terraces as stacked slabs, each a level tread cut by a
 * sloped wall standing on the distance to the terrace's own footprint,
 * over the seabed's ground. Distances are in world units: map units
 * across, and `exaggeration` world units a unit of elevation up, as the
 * preview stands its mesh.
 *
 * What it takes to stay a distance (gradient length close to 1):
 *
 * - **Footprints by exact distance.** The coast's is the exact coast
 *   distance (`screen-terrain-coast.ts`); every escarpment's is measured
 *   again, exactly, from the contour of the landform at the escarpment's
 *   middle height, traced on the field lattice. The landform's own value
 *   divided by its slope is only a first-order estimate, wrong by its
 *   curvature off the contour.
 * - **Walls normalised.** A wall rising `s` world units a unit across
 *   `D` is `(D·s + z − m) / √(1 + s²)`: exactly a distance to its plane.
 * - **Treads and ground normalised** by `√(1 + |∇T|²)`: a first-order
 *   distance to a gentle surface, near exact where it is level.
 * - **Sharp joins are max and min; soft joins a bounded polynomial
 *   smooth minimum**, whose gradient is a convex blend of its arguments',
 *   so neither can lift the gradient past 1. A lip is a max, kept sharp
 *   for the mesher to find; a foot is a smooth minimum of small radius.
 * - **No noise in the geometry.** The land's fine relief tilts the normal
 *   in the shader, as the preview's does.
 */

/** How the island's slabs are cut and joined. */
export interface SdfIslandSettings {
  /** World units a unit of elevation, as the preview's `exaggeration`. */
  exaggeration: number;
  /** Radius of the smooth minimum at an escarpment's foot and the ground, world units. */
  foot: number;
  /** Map units of land beyond the coast's bounds the field covers. */
  margin: number;
  /** Map units past which a footprint's distance is held, beyond any wall's reach. */
  reach: number;
  /**
   * The seabed's meeting with the coast, as the screen terrain's bake: at
   * least `slope` elevation a map unit out from the coast once `reach`
   * out, easing in from level at the coast.
   */
  shore: { reach: number; slope: number };
  /** Map units between the field's lattice samples. */
  spacing: number;
  /**
   * A wall's rise, world units a map unit: the escarpment's steepness
   * from its landform's record, times `steepen`, held between `least` and
   * `most` (see `islandSlabProfile`).
   */
  wall: { least: number; most: number; steepen: number };
}

export const defaultSdfIslandSettings: SdfIslandSettings = {
  exaggeration: 14,
  foot: 0.35,
  margin: 14,
  reach: 8,
  shore: { reach: 2, slope: 0.006 },
  spacing: 0.5,
  wall: { least: 1.5, most: 8, steepen: 1.4 },
};

/** The levels an island's terraces stand at, elevation units, from its landform's record. */
interface TerraceProfile {
  /** The beach bench's elevation. */
  bench: number;
  /** Map units of the beach's seaward face. */
  face: number;
  /**
   * Each tread from the lowest: its elevation at its lip (`low`) and where
   * it ends at the next escarpment (`high`), and the escarpment below it's
   * middle (`middle`).
   */
  treads: { high: number; low: number; middle: number }[];
}

/**
 * The terrace levels `kernelLandform` steps an island into, from its
 * record: a tread climbs from just under its level to it by the
 * formation's softness, the escarpment below it rising from the tread
 * beneath over `riser` of a step.
 */
function terraceProfile(
  record: readonly number[],
  pieceDepth: number,
  settings = defaultLandformSettings
): TerraceProfile {
  const height = record[islandSlots.height] ?? 0;
  const bench = record[islandSlots.beachHeight] ?? 0;
  const count = Math.max(1, Math.round(record[islandSlots.terraces] ?? 1));
  const riser = record[islandSlots.riser] ?? 0;
  const softness = record[islandSlots.softness] ?? 0;
  const beach = Math.min(
    settings.beach.width,
    settings.beach.share * pieceDepth
  );
  const level = (share: number) => bench + (height - bench) * share;
  const treads: TerraceProfile["treads"] = [];
  let below = bench;
  for (let step = 1; step <= count; step += 1) {
    const high = level(step / count);
    const low = level(step / count - (softness * (1 - riser)) / count);
    treads.push({ high, low, middle: (below + low) / 2 });
    below = high;
  }
  return { bench, face: beach * settings.beach.lip, treads };
}

/** The cubic B-spline of a world-grid field at a map position, with its slope per map unit. */
function gridSpline(
  grid: Pick<WorldTerrain, "cell" | "height" | "left" | "top" | "width">,
  values: ArrayLike<number>,
  x: number,
  y: number,
  map: (value: number) => number = (value) => value
): { slopeX: number; slopeY: number; value: number } {
  const u = (x - grid.left) / grid.cell - 0.5;
  const v = (y - grid.top) / grid.cell - 0.5;
  const column = Math.floor(u);
  const row = Math.floor(v);
  const weights = (t: number) => {
    const s = 1 - t;
    return [
      (s * s * s) / 6,
      (3 * t * t * t - 6 * t * t + 4) / 6,
      (-3 * t * t * t + 3 * t * t + 3 * t + 1) / 6,
      (t * t * t) / 6,
    ];
  };
  const slopes = (t: number) => {
    const s = 1 - t;
    return [
      -0.5 * s * s,
      1.5 * t * t - 2 * t,
      -1.5 * t * t + t + 0.5,
      0.5 * t * t,
    ];
  };
  const wx = weights(u - column);
  const wy = weights(v - row);
  const dx = slopes(u - column);
  const dy = slopes(v - row);
  let value = 0;
  let slopeX = 0;
  let slopeY = 0;
  for (let j = 0; j < 4; j += 1) {
    const r = Math.min(grid.height - 1, Math.max(0, row + j - 1));
    for (let i = 0; i < 4; i += 1) {
      const c = Math.min(grid.width - 1, Math.max(0, column + i - 1));
      const texel = map(values[r * grid.width + c] ?? 0);
      value += texel * (wx[i] ?? 0) * (wy[j] ?? 0);
      slopeX += texel * (dx[i] ?? 0) * (wy[j] ?? 0);
      slopeY += texel * (wx[i] ?? 0) * (dy[j] ?? 0);
    }
  }
  return { slopeX: slopeX / grid.cell, slopeY: slopeY / grid.cell, value };
}

/**
 * The seabed at a map position as the screen terrain's bake composes it,
 * on the CPU: the world's seabed before the terrace pass read as a cubic
 * B-spline, its terraces cut at the spline's slope by the pass's own
 * kernel, the detail pass added back, at most the shore's ramp from the
 * coast, and an atoll's inlet channels cut past the coast.
 */
export function seabedElevation(
  world: WorldTerrain,
  coast: number,
  x: number,
  y: number,
  settings: Pick<SdfIslandSettings, "shore"> = defaultSdfIslandSettings,
  lagoonSettings: LagoonSettings = defaultLagoonSettings
): number {
  const field = gridSpline(world, world.featured, x, y, (value) =>
    Math.min(geologyLevels.waterLevel, value)
  );
  const detail = gridSpline(world, world.detail, x, y).value;
  const seabed =
    kernelTerrace(
      numberMath,
      field.value,
      Math.hypot(field.slopeX, field.slopeY),
      defaultWorldTerrainSettings.terrace
    ) + detail;
  const { reach, slope } = settings.shore;
  const shore =
    coast * -slope * Math.min(coast / reach, 1) + Math.max(coast - reach, 0);
  let elevation = Math.min(seabed, shore);
  if (coast >= 0 && world.lagoons.length > 0) {
    const channel = inletChannel(world.lagoons, lagoonSettings, x, y);
    if (channel > 0) {
      elevation = Math.min(elevation, elevationAtDepth(channel));
    }
  }
  return elevation;
}

/** The piece depth `world-terrain` gives a position: its cell's own, or on water its neighbours' deepest. */
function pieceDepthAt(world: WorldTerrain, x: number, y: number): number {
  const column = Math.min(
    world.width - 1,
    Math.max(0, Math.floor((x - world.left) / world.cell))
  );
  const row = Math.min(
    world.height - 1,
    Math.max(0, Math.floor((y - world.top) / world.cell))
  );
  const own = world.pieceDepth[row * world.width + column] ?? 0;
  if (own > 0) {
    return own;
  }
  let deepest = 0;
  for (
    let r = Math.max(0, row - 1);
    r <= Math.min(world.height - 1, row + 1);
    r += 1
  ) {
    for (
      let c = Math.max(0, column - 1);
      c <= Math.min(world.width - 1, column + 1);
      c += 1
    ) {
      deepest = Math.max(deepest, world.pieceDepth[r * world.width + c] ?? 0);
    }
  }
  return deepest;
}

/** Map units either side of an escarpment's middle over which the first-order estimate is checked. */
const contourBand = 4;

/** Map units a sample stands from the coast where the island's bins list none. */
const farFromCoast = 10_000;

/** A field on a lattice of map positions, row 0 at the top. */
export interface FieldLattice {
  columns: number;
  left: number;
  rows: number;
  spacing: number;
  top: number;
}

/** A cell's sides, top, right, bottom and left, as marching squares names them. */
type Side = 0 | 1 | 2 | 3;

/**
 * The sides each corner case joins, by the case's code (top left 1, top
 * right 2, bottom right 4, bottom left 8, set where the corner is inside):
 * a case and its complement join the same sides. The saddles, 5 and 10,
 * are split by the cell's mean in `cellSegments`.
 */
const sideCases: Record<number, readonly [Side, Side][]> = {
  1: [[3, 0]],
  2: [[0, 1]],
  3: [[3, 1]],
  4: [[1, 2]],
  6: [[0, 2]],
  7: [[3, 2]],
};

/** The sides one cell's contour joins, corners `a` (top left), `b`, `c`, `d` clockwise, each less the level. */
function cellSides(
  a: number,
  b: number,
  c: number,
  d: number
): readonly [Side, Side][] {
  const code =
    (a >= 0 ? 1 : 0) + (b >= 0 ? 2 : 0) + (c >= 0 ? 4 : 0) + (d >= 0 ? 8 : 0);
  if (code === 5 || code === 10) {
    // a and c agree: the cell's mean joins them or splits them.
    const joined = (a + b + c + d) / 4 >= 0 === a >= 0;
    return joined
      ? [
          [0, 1],
          [2, 3],
        ]
      : [
          [3, 0],
          [1, 2],
        ];
  }
  return sideCases[Math.min(code, 15 - code)] ?? [];
}

/**
 * Segments of the contour `level` of a lattice field, marching squares
 * with saddles split by the cell's mean, four floats a segment in map
 * units.
 */
export function contourSegments(
  lattice: FieldLattice,
  values: ArrayLike<number>,
  level: number
): number[] {
  const { columns, rows, spacing, left, top } = lattice;
  const out: number[] = [];
  const at = (column: number, row: number) =>
    (values[row * columns + column] ?? 0) - level;
  const share = (p: number, q: number) => p / (p - q);
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const a = at(column, row);
      const b = at(column + 1, row);
      const c = at(column + 1, row + 1);
      const d = at(column, row + 1);
      const x0 = left + column * spacing;
      const y0 = top + row * spacing;
      // The crossing on each side: top, right, bottom, left.
      const crossings = [
        () => [x0 + share(a, b) * spacing, y0],
        () => [x0 + spacing, y0 + share(b, c) * spacing],
        () => [x0 + share(d, c) * spacing, y0 + spacing],
        () => [x0, y0 + share(a, d) * spacing],
      ];
      for (const [from, to] of cellSides(a, b, c, d)) {
        out.push(...(crossings[from]?.() ?? []), ...(crossings[to]?.() ?? []));
      }
    }
  }
  return out;
}

/**
 * The exact distance from each lattice sample to a set of segments, out
 * to `reach` and held there, negative where `inside` holds: a band
 * rasterised segment by segment, so it costs the band's area, not the
 * lattice's times the segments'.
 */
export function segmentDistance(
  lattice: FieldLattice,
  segments: readonly number[],
  reach: number,
  inside: (index: number) => boolean
): Float32Array {
  const { columns, rows, spacing, left, top } = lattice;
  const nearest = new Float32Array(columns * rows).fill(reach * reach);
  const band = Math.ceil(reach / spacing);
  for (let at = 0; at < segments.length; at += 4) {
    const ax = segments[at] ?? 0;
    const ay = segments[at + 1] ?? 0;
    const bx = segments[at + 2] ?? 0;
    const by = segments[at + 3] ?? 0;
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const c0 = Math.max(
      0,
      Math.floor((Math.min(ax, bx) - left) / spacing) - band
    );
    const c1 = Math.min(
      columns - 1,
      Math.ceil((Math.max(ax, bx) - left) / spacing) + band
    );
    const r0 = Math.max(
      0,
      Math.floor((Math.min(ay, by) - top) / spacing) - band
    );
    const r1 = Math.min(
      rows - 1,
      Math.ceil((Math.max(ay, by) - top) / spacing) + band
    );
    for (let row = r0; row <= r1; row += 1) {
      const y = top + row * spacing;
      for (let column = c0; column <= c1; column += 1) {
        const x = left + column * spacing;
        const t =
          length > 0
            ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length))
            : 0;
        const ex = x - ax - t * dx;
        const ey = y - ay - t * dy;
        const squared = ex * ex + ey * ey;
        const index = row * columns + column;
        if (squared < (nearest[index] ?? 0)) {
          nearest[index] = squared;
        }
      }
    }
  }
  return nearest.map((squared, index) =>
    inside(index) ? -Math.sqrt(squared) : Math.sqrt(squared)
  );
}

/** An island's signed distance and what it was built from. */
export interface SdfIsland extends SdfField {
  /** The lattice columns the slab kernel reads, `columnStride` floats each. */
  columns: Float32Array;
  /**
   * How far the first-order estimate of an escarpment's footprint
   * distance (height off its middle over the slope) strays from the
   * traced distance, map units, within `contourBand` of the wall.
   */
  contourEstimate: {
    mean: number;
    median: number;
    p95: number;
    samples: number;
  };
  /** The lattice the fields were sampled on. */
  fields: FieldLattice;
  /** World units of height of the land and seabed at each lattice sample, as the height field the preview would mesh. */
  heightField: Float32Array;
  islandId: string;
  /** Milliseconds each stage took. */
  milliseconds: { fields: number; slabs: number };
  profile: TerraceProfile;
  /** The world height range the surface spans, with a lattice step either side. */
  range: { high: number; low: number };
  /** The island's slabs, as the kernel reads them packed. */
  slabs: SlabProfile;
  /** Each wall's rise, world units a map unit, from the bench up. */
  slopes: number[];
  /** The analytic height of the surface over a world (x, y): the slabs' and the ground's, without the blends. */
  surfaceHeight(x: number, y: number): number;
}

/** A field's slope length at each lattice sample by central differences, per map unit. */
function slopeLength(
  lattice: FieldLattice,
  values: Float32Array
): Float32Array {
  const { columns, rows, spacing } = lattice;
  const out = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const l = values[row * columns + Math.max(0, column - 1)] ?? 0;
      const r = values[row * columns + Math.min(columns - 1, column + 1)] ?? 0;
      const u = values[Math.max(0, row - 1) * columns + column] ?? 0;
      const d = values[Math.min(rows - 1, row + 1) * columns + column] ?? 0;
      const wx =
        (Math.min(columns - 1, column + 1) - Math.max(0, column - 1)) * spacing;
      const wy = (Math.min(rows - 1, row + 1) - Math.max(0, row - 1)) * spacing;
      out[row * columns + column] = Math.hypot((r - l) / wx, (d - u) / wy);
    }
  }
  return out;
}

/** The coast's bounds of an island, map units. */
function islandBounds(island: WorldTerrain["islands"][number]) {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const polygon of island.coast) {
    for (const ring of polygon) {
      for (const [x = 0, y = 0] of ring) {
        left = Math.min(left, island.x + x);
        right = Math.max(right, island.x + x);
        top = Math.min(top, island.y + y);
        bottom = Math.max(bottom, island.y + y);
      }
    }
  }
  return { bottom, left, right, top };
}

/**
 * The raw fields of an island over its lattice: the exact coast distance,
 * the land's elevation where the coast holds land, and the ground under
 * the water (seabed outside the coast, the lagoon's floor inside).
 */
function islandFields(
  world: WorldTerrain,
  islandId: string,
  settings: SdfIslandSettings = defaultSdfIslandSettings
) {
  const island = world.islands.find((each) => each.id === islandId);
  if (!island) {
    throw new Error(`No island ${islandId} in the world.`);
  }
  const bounds = islandBounds(island);
  const { spacing, margin } = settings;
  const left = Math.floor((bounds.left - margin) / spacing) * spacing;
  const top = Math.floor((bounds.top - margin) / spacing) * spacing;
  const columns = Math.ceil((bounds.right + margin - left) / spacing) + 1;
  const rows = Math.ceil((bounds.bottom + margin - top) / spacing) + 1;
  const lattice: FieldLattice = { columns, left, rows, spacing, top };
  // This island's coast alone, so a neighbour inside the margin never
  // becomes the nearest coast.
  const segments = coastSegments([island], [islandId]);
  const bins = coastBins([island], [islandId], segments, {
    cell: 8,
    height: Math.ceil((world.height * world.cell) / 8),
    left: world.left,
    top: world.top,
    width: Math.ceil((world.width * world.cell) / 8),
  });
  const coast = new Float32Array(columns * rows);
  const land = new Float32Array(columns * rows);
  const ground = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    const y = top + row * spacing;
    for (let column = 0; column < columns; column += 1) {
      const x = left + column * spacing;
      const index = row * columns + column;
      // Bins past the island's own list no coast: open sea, far off.
      const distance = Math.min(
        coastDistance(bins, segments, x, y).distance,
        farFromCoast
      );
      coast[index] = distance;
      // Inside the coast the seabed is read at the coast itself, so the
      // ground meets the land level there rather than diving under it.
      const seabed = seabedElevation(
        world,
        Math.max(0, distance),
        x,
        y,
        settings
      );
      if (distance < 0) {
        const height = world.landform({
          inland: -distance,
          islandId,
          pieceDepth: pieceDepthAt(world, x, y),
          x,
          y,
        });
        land[index] = height;
        ground[index] = Math.min(height, 0, seabed);
      } else {
        land[index] = Math.min(0, seabed);
        ground[index] = seabed;
      }
    }
  }
  return { coast, ground, land, lattice };
}

/** Bilinear weights of a world (x, y) on a field lattice: the four samples' indices and weights. */
function bilinear(lattice: FieldLattice, x: number, worldY: number) {
  const u = (x - lattice.left) / lattice.spacing;
  const v = (-worldY - lattice.top) / lattice.spacing;
  const column = Math.min(lattice.columns - 2, Math.max(0, Math.floor(u)));
  const row = Math.min(lattice.rows - 2, Math.max(0, Math.floor(v)));
  const s = Math.min(1, Math.max(0, u - column));
  const t = Math.min(1, Math.max(0, v - row));
  const i00 = row * lattice.columns + column;
  return {
    i00,
    i01: i00 + lattice.columns,
    i10: i00 + 1,
    i11: i00 + lattice.columns + 1,
    w00: (1 - s) * (1 - t),
    w01: (1 - s) * t,
    w10: s * (1 - t),
    w11: s * t,
  };
}

/**
 * The bench's footprint distance: inside the coast, outside any lagoon.
 * The coast's distance is exact, and never held: the bench's face is
 * gentle, so a held distance would stand a false floor over deep water. A
 * lagoon's shore is traced from the land, the sea counting as water too,
 * so no traced line crosses an inlet's mouth, where the traced coast and
 * the exact one would leave a sliver of land between them; where the sea
 * meets land the traced line only doubles the exact coast, which the
 * maximum keeps.
 */
function benchDistance(
  fields: ReturnType<typeof islandFields>,
  settings: SdfIslandSettings
): Float32Array {
  const { coast, land, lattice } = fields;
  const lagoonField = Float32Array.from(land, (value, index) =>
    (coast[index] ?? 0) < 0 ? value : -1
  );
  const hasLagoon = lagoonField.some(
    (value, index) => value < 0 && (coast[index] ?? 0) < 0
  );
  const shore = hasLagoon ? contourSegments(lattice, lagoonField, 0) : [];
  if (shore.length === 0) {
    return Float32Array.from(coast);
  }
  const lagoon = segmentDistance(
    lattice,
    shore,
    settings.reach,
    (index) => (lagoonField[index] ?? 0) < 0
  );
  return Float32Array.from(coast, (toCoast, index) =>
    Math.max(toCoast, -(lagoon[index] ?? 0))
  );
}

/**
 * One escarpment's footprint distance: the land at or above its middle
 * height, measured again from the traced contour and held at `reach`.
 * Pushes the first-order estimate's error near the wall onto `errors`.
 */
function escarpmentDistance(
  fields: ReturnType<typeof islandFields>,
  middle: number,
  settings: SdfIslandSettings,
  errors: number[]
): Float32Array {
  const { coast, land, lattice } = fields;
  const slopes = slopeLength(lattice, land);
  const distance = segmentDistance(
    lattice,
    contourSegments(lattice, land, middle),
    settings.reach,
    (index) => (land[index] ?? 0) >= middle && (coast[index] ?? 0) < 0
  );
  for (const [index, exact] of distance.entries()) {
    const slope = slopes[index] ?? 0;
    // The first-order estimate of the same distance: the land's height
    // off the middle over its slope.
    if (Math.abs(exact) < contourBand && slope > 1e-6) {
      const estimate = (middle - (land[index] ?? 0)) / slope;
      errors.push(Math.abs(Math.abs(estimate) - Math.abs(exact)));
    }
  }
  return distance;
}

/** World units of ground a wall must clear where its footprint's distance is held at `reach`. */
const wallClearance = 8;

/**
 * An island's slabs from its landform's record: the bench, its face from
 * the beach's lip, then a wall at each escarpment's middle height. A
 * wall's rise is the escarpment's: its height over the riser's share of
 * a step of the inland distance, at the smoothstep's steepest (1.5 times
 * its mean), steepened and held; and at least steep enough that, where
 * its footprint's distance is held at `reach`, it stands `wallClearance`
 * under the water, so it never stands a false floor over the seabed.
 */
export function islandSlabProfile(
  record: readonly number[],
  pieceDepth: number,
  settings: SdfIslandSettings = defaultSdfIslandSettings,
  landforms = defaultLandformSettings
): SlabProfile {
  const profile = terraceProfile(record, pieceDepth, landforms);
  const X = settings.exaggeration;
  const count = Math.max(1, Math.round(record[islandSlots.terraces] ?? 1));
  const beach = Math.min(
    landforms.beach.width,
    landforms.beach.share * pieceDepth
  );
  const reach = record[islandSlots.reach] ?? 1;
  const riser = Math.max(record[islandSlots.riser] ?? 0, 1e-3);
  const run = Math.max(riser * ((reach - beach) / count), 1e-3);
  let below = profile.bench;
  const terraces = profile.treads.map((tread) => {
    const rise = ((tread.low - below) * X * 1.5) / run;
    below = tread.high;
    const floor = (tread.middle * X + wallClearance) / settings.reach;
    return {
      high: tread.high,
      low: tread.low,
      middle: tread.middle * X,
      offset: 0,
      slope: Math.max(
        floor,
        Math.min(
          settings.wall.most,
          Math.max(settings.wall.least, rise * settings.wall.steepen)
        )
      ),
    };
  });
  return {
    exaggeration: X,
    foot: settings.foot,
    slabs: [
      {
        high: profile.bench,
        low: profile.bench,
        middle: (profile.bench * X) / 2,
        offset: profile.face / 2,
        slope: (profile.bench * X) / Math.max(profile.face, 1e-3),
      },
      ...terraces,
    ],
  };
}

/**
 * The lattice columns the slab kernel reads, `columnStride` floats each:
 * the land, the ground's height and normalisation, each slab's tread
 * normalisation and footprint distance.
 */
function packColumns(
  fields: ReturnType<typeof islandFields>,
  profile: SlabProfile,
  distances: readonly Float32Array[]
): Float32Array {
  const { land, lattice } = fields;
  const X = profile.exaggeration;
  const count = lattice.columns * lattice.rows;
  const columns = new Float32Array(count * columnStride);
  const ground = Float32Array.from(fields.ground, (value) => value * X);
  const groundSlope = slopeLength(lattice, ground);
  const treadSlopes = profile.slabs.map((slab) =>
    slopeLength(
      lattice,
      Float32Array.from(
        land,
        (value) => Math.min(slab.high, Math.max(slab.low, value)) * X
      )
    )
  );
  for (let index = 0; index < count; index += 1) {
    const at = index * columnStride;
    columns[at + columnSlots.land] = land[index] ?? 0;
    columns[at + columnSlots.groundHeight] = ground[index] ?? 0;
    columns[at + columnSlots.groundScale] =
      1 / Math.hypot(1, groundSlope[index] ?? 0);
    for (let slab = 0; slab < slabCount; slab += 1) {
      columns[at + columnSlots.treadScale + slab] =
        1 / Math.hypot(1, treadSlopes[slab]?.[index] ?? 0);
      columns[at + columnSlots.distance + slab] =
        distances[slab]?.[index] ?? settingsFar;
    }
  }
  return columns;
}

/** A footprint distance for a slab an island lacks: far outside it. */
const settingsFar = 1e4;

/** Mean, median and 95th percentile of some errors. */
function errorSummary(errors: number[]) {
  errors.sort((a, b) => a - b);
  return {
    mean:
      errors.reduce((sum, value) => sum + value, 0) /
      Math.max(1, errors.length),
    median: errors[Math.floor(errors.length / 2)] ?? 0,
    p95: errors[Math.floor(errors.length * 0.95)] ?? 0,
    samples: errors.length,
  };
}

/**
 * An island as a signed distance in world units (x right, y up the
 * chart, z up), its slabs built from the landform's terraces and its
 * ground from the seabed and lagoon, evaluated by the slab kernel on
 * plain numbers: the reference the GPU's passes are held to.
 */
export function sdfIsland(
  world: WorldTerrain,
  landforms: ReadonlyMap<string, IslandLandform>,
  islandId: string,
  settings: SdfIslandSettings = defaultSdfIslandSettings
): SdfIsland {
  const started = performance.now();
  const fields = islandFields(world, islandId, settings);
  const { coast, land, lattice } = fields;
  const fieldsDone = performance.now();
  const record = packLandforms(landforms, [islandId], undefined, world.lagoons);
  const depth = landforms.get(islandId)?.params.depth ?? 0;
  const profile = terraceProfile(record, depth);
  const slabs = islandSlabProfile(record, depth, settings);
  const errors: number[] = [];
  const distances = [
    benchDistance(fields, settings),
    ...profile.treads.map((tread) =>
      escarpmentDistance(fields, tread.middle, settings, errors)
    ),
  ];
  const columns = packColumns(fields, slabs, distances);
  const packed = packSlabProfile(slabs);
  const slabsDone = performance.now();
  const X = settings.exaggeration;

  const corners = (x: number, y: number) => {
    const w = bilinear(lattice, x, y);
    return {
      indices: [w.i00, w.i10, w.i01, w.i11],
      weights: [w.w00, w.w10, w.w01, w.w11],
    };
  };
  const distance = (x: number, y: number, z: number): number => {
    const { indices, weights } = corners(x, y);
    return kernelSlabField(
      numberMath,
      (corner, slot) =>
        columns[(indices[corner] ?? 0) * columnStride + slot] ?? 0,
      weights,
      z,
      (slot) => packed[slot] ?? 0
    );
  };
  const surfaceHeight = (x: number, y: number): number => {
    const { indices, weights } = corners(x, y);
    const read = (slot: number) =>
      indices.reduce(
        (sum, index, corner) =>
          sum +
          (weights[corner] ?? 0) * (columns[index * columnStride + slot] ?? 0),
        0
      );
    let height = read(columnSlots.groundHeight);
    for (const [index, slab] of slabs.slabs.entries()) {
      const tread = indices.reduce(
        (sum, at, corner) =>
          sum +
          (weights[corner] ?? 0) *
            Math.min(
              slab.high,
              Math.max(slab.low, columns[at * columnStride] ?? 0)
            ),
        0
      );
      height = Math.max(
        height,
        Math.min(
          tread * X,
          slab.middle -
            (read(columnSlots.distance + index) + slab.offset) * slab.slope
        )
      );
    }
    return height;
  };

  const ground = fields.ground.map((value) => value * X);
  const low = ground.reduce(
    (least, value) => Math.min(least, value),
    Number.POSITIVE_INFINITY
  );
  const high =
    Math.max(profile.bench, ...profile.treads.map((tread) => tread.high)) * X;
  return {
    columns,
    contourEstimate: errorSummary(errors),
    distance,
    fields: lattice,
    heightField: Float32Array.from(land, (value, index) =>
      (coast[index] ?? 0) < 0 ? value * X : (ground[index] ?? 0)
    ),
    islandId,
    milliseconds: {
      fields: fieldsDone - started,
      slabs: slabsDone - fieldsDone,
    },
    profile,
    range: { high: high + 2 * lattice.spacing, low: low - 2 * lattice.spacing },
    slabs,
    slopes: slabs.slabs.map((slab) => slab.slope),
    surfaceHeight,
  };
}

/** The lattice the trial meshes an island on: its field lattice's columns and rows, in world units, z over its range. */
export function islandLattice(
  island: SdfIsland,
  spacing = island.fields.spacing
) {
  const { fields } = island;
  const width = (fields.columns - 1) * fields.spacing;
  const height = (fields.rows - 1) * fields.spacing;
  return {
    origin: [fields.left, -(fields.top + height), island.range.low] as const,
    size: [
      Math.floor(width / spacing) + 1,
      Math.floor(height / spacing) + 1,
      Math.ceil((island.range.high - island.range.low) / spacing) + 1,
    ] as const,
    spacing,
  };
}

/** How far a field's gradient length strays from 1 near its surface. */
export interface LipschitzReport {
  /** Largest gradient length met. */
  max: number;
  mean: number;
  /** Mean of |gradient length − 1|. */
  meanError: number;
  /** Share of samples whose gradient is longer than 1.1. */
  over: number;
  p99: number;
  samples: number;
}

/**
 * The gradient length of `distance` at seeded points within `band` world
 * units of its surface, inside `bounds`: central differences `step` apart.
 */
export function lipschitzReport(
  distance: (x: number, y: number, z: number) => number,
  bounds: { high: readonly number[]; low: readonly number[] },
  options: { band: number; samples: number; step: number }
): LipschitzReport {
  const lengths: number[] = [];
  let seed = 2_654_435_769;
  const random = () => {
    // A linear congruential sequence, exact in doubles: deterministic, so
    // the report is repeatable.
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return seed / 4_294_967_296;
  };
  const [lx = 0, ly = 0, lz = 0] = bounds.low;
  const [hx = 0, hy = 0, hz = 0] = bounds.high;
  let attempts = 0;
  while (lengths.length < options.samples && attempts < options.samples * 400) {
    attempts += 1;
    const x = lx + (hx - lx) * random();
    const y = ly + (hy - ly) * random();
    const z = lz + (hz - lz) * random();
    if (Math.abs(distance(x, y, z)) > options.band) {
      continue;
    }
    const s = options.step;
    const gx = (distance(x + s, y, z) - distance(x - s, y, z)) / (2 * s);
    const gy = (distance(x, y + s, z) - distance(x, y - s, z)) / (2 * s);
    const gz = (distance(x, y, z + s) - distance(x, y, z - s)) / (2 * s);
    lengths.push(Math.hypot(gx, gy, gz));
  }
  const sorted = [...lengths].sort((a, b) => a - b);
  const count = Math.max(1, sorted.length);
  return {
    max: sorted.at(-1) ?? 0,
    mean: sorted.reduce((sum, value) => sum + value, 0) / count,
    meanError:
      sorted.reduce((sum, value) => sum + Math.abs(value - 1), 0) / count,
    over: sorted.filter((value) => value > 1.1).length / count,
    p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
    samples: sorted.length,
  };
}

/**
 * The same island as the height field the preview meshes, as the two
 * distances a mesher could be handed instead of the slabs: the height
 * difference itself (`naive`), and that divided by the slope's
 * normalisation (`firstOrder`), a distance only where the surface is
 * locally flat.
 */
export function heightFieldDistances(island: SdfIsland) {
  const lattice = island.fields;
  const heights = island.heightField;
  const slope = slopeLength(lattice, heights);
  const read = (values: Float32Array, x: number, y: number) => {
    const w = bilinear(lattice, x, y);
    return (
      (values[w.i00] ?? 0) * w.w00 +
      (values[w.i10] ?? 0) * w.w10 +
      (values[w.i01] ?? 0) * w.w01 +
      (values[w.i11] ?? 0) * w.w11
    );
  };
  return {
    firstOrder: (x: number, y: number, z: number) =>
      (z - read(heights, x, y)) / Math.hypot(1, read(slope, x, y)),
    naive: (x: number, y: number, z: number) => z - read(heights, x, y),
  };
}
