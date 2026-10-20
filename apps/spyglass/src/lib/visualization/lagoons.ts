import { shoreDistances } from "./distance-field";
import { elevationAtDepth, type GeologyGrid, type Landform } from "./geology";
import {
  type FractalSettings,
  fbm,
  gradientNoise,
  latticeHash,
  noiseSeed,
} from "./noise";

/**
 * Atoll lagoons and their inlets: the one place the land inside a coast
 * goes below the water. An atoll's landform raises a rim; inside it, past
 * `shore` map units inland, the lagoon's water lies over a sandy floor,
 * shallow at its edge and deepening toward the middle, with a few patch
 * reefs rising to just under the surface. The rim meets the water through
 * an inner beach: a lip and a flat sand margin before the rim's slope.
 * One inlet, or two through a large rim, runs from the lagoon to open
 * water, its floor ramping from the lagoon's depth to the apron's and on
 * into the seabed outside. Everything here is a function of a map position
 * and the distance inland, so the world grid and the preview's fine lattice
 * read one lagoon.
 */
export interface LagoonSettings {
  /** Map units from the water's edge over which the floor falls from `depth.edge` to its full depth. */
  bank: number;
  /** Share of the way from the shore to the lagoon's deepest point at which the floor reaches `depth.centre`. */
  basin: number;
  /**
   * The inner beach: its lip rises over `lip` map units from the water to
   * the beach bench, the bench holds for `width`, and beyond it the sand
   * climbs `rise` elevation units a map unit until it meets the rim.
   */
  beach: { lip: number; rise: number; width: number };
  /** Nominal metres of water: at the very edge, at the shore once past the bank, and at the lagoon's deepest. */
  depth: { centre: number; edge: number; shore: number };
  /** Relief of the lagoon floor: nominal metres either way, and the noise's wavelength in map units. */
  floor: FractalSettings & { amplitude: number; wavelength: number };
  inlet: {
    /** Map units from the water's edge over which an inlet's floor falls to its centre line. */
    bank: number;
    /** Nominal metres over the inlet's floor where it crosses the coast. */
    depth: number;
    /** An inlet's mouth this many times wider than its throat. */
    flare: number;
    /** Lagoons of at least this many square map units take a second inlet. */
    largeArea: number;
    /** Map units past the coast over which open water is looked for. */
    look: number;
    /** Map units either side of the inlet's centre line it meanders, and how many half waves. */
    meander: { amplitude: number; waves: number };
    /** Map units the inlet's channel runs on past the coast, fading into the seabed. */
    reach: number;
    /** Map units of a long rim crossing that cost as much as one map unit of open water. */
    rimCost: number;
    /** How the inlet's banks wander: a share of its width they may widen by, and the wavelength along it in map units. */
    wander: { share: number; wavelength: number };
    /** Map units across the inlet's throat; at least three grid cells so the grid keeps it. */
    width: number;
  };
  /** Patch reefs: knolls rising to `top` nominal metres, one per `spacing` square map units of lagoon at most. */
  reefs: { radius: { max: number; min: number }; spacing: number; top: number };
  seed: string;
  /** How the lagoon's shore wanders: map units either way and the noise's wavelength. */
  shore: FractalSettings & { amplitude: number; wavelength: number };
}

export const defaultLagoonSettings: LagoonSettings = {
  bank: 7,
  basin: 0.6,
  beach: { lip: 1.6, rise: 0.035, width: 4 },
  depth: { centre: 8, edge: 0.4, shore: 1.5 },
  floor: {
    amplitude: 1.2,
    gain: 0.5,
    lacunarity: 2,
    octaves: 2,
    wavelength: 22,
  },
  inlet: {
    bank: 5,
    depth: 6,
    flare: 1.5,
    largeArea: 9000,
    look: 160,
    meander: { amplitude: 4, waves: 1.5 },
    reach: 36,
    rimCost: 3,
    wander: { share: 0.3, wavelength: 14 },
    width: 14,
  },
  reefs: { radius: { max: 6, min: 3.5 }, spacing: 700, top: 0.6 },
  seed: "spyglass:lagoon",
  shore: {
    amplitude: 2.5,
    gain: 0.5,
    lacunarity: 2,
    octaves: 2,
    wavelength: 28,
  },
};

/** Where an atoll's lagoon lies: its island, and the landform's anatomy around it. */
export interface LagoonSite {
  /** Beach bench height of the island's landform, in elevation units. */
  beachHeight: number;
  islandId: string;
  /** Map units inland at which the lagoon's water begins: past the rim, where the landform has fallen. */
  shore: number;
}

/** An inlet's centre line, from inside the lagoon out past the coast. */
export interface Inlet {
  /** Map-unit bounds of the line, widened by the mouth's half width: nothing outside is in the inlet. */
  bounds: { bottom: number; left: number; right: number; top: number };
  /** Map units along the line where it crosses the coast. */
  coast: number;
  /** Map units along the line where it leaves the lagoon. */
  lagoon: number;
  /** Map units along the line to each point. */
  lengths: readonly number[];
  points: readonly (readonly [number, number])[];
  /** Seeds the wander of the inlet's banks. */
  seed: number;
}

/** One atoll's planned lagoon. */
export interface Lagoon extends LagoonSite {
  /** Map units inland of the deepest point of the atoll's land. */
  depth: number;
  inlets: readonly Inlet[];
  reefs: readonly { radius: number; x: number; y: number }[];
  /** The floor's and the shore's noise seeds. */
  seeds: { floor: number; shore: number };
}

/** The grid fields a lagoon is planned over: the preview's coast distance and owners. */
export interface LagoonGrid extends GeologyGrid {
  islandIds: readonly string[];
  owner: Int32Array;
  signedDistance: ArrayLike<number>;
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** Bilinear value of a cell field at a map position, clamped to the grid. */
function sampleCells(
  grid: GeologyGrid,
  values: ArrayLike<number>,
  x: number,
  y: number
): number {
  const u = Math.min(
    grid.width - 1,
    Math.max(0, (x - grid.left) / grid.cell - 0.5)
  );
  const v = Math.min(
    grid.height - 1,
    Math.max(0, (y - grid.top) / grid.cell - 0.5)
  );
  const column = Math.min(grid.width - 2, Math.floor(u));
  const row = Math.min(grid.height - 2, Math.floor(v));
  const s = u - column;
  const t = v - row;
  const at = row * grid.width + column;
  const north = (values[at] ?? 0) * (1 - s) + (values[at + 1] ?? 0) * s;
  const south =
    (values[at + grid.width] ?? 0) * (1 - s) +
    (values[at + grid.width + 1] ?? 0) * s;
  return north * (1 - t) + south * t;
}

/** Map units the shore stands in from `shore` at a position: seeded noise either way. */
function shoreOffset(
  lagoon: Pick<Lagoon, "seeds">,
  settings: LagoonSettings,
  x: number,
  y: number
): number {
  const { shore } = settings;
  return (
    shore.amplitude *
    fbm(x / shore.wavelength, y / shore.wavelength, lagoon.seeds.shore, shore)
  );
}

/** Map units into the lagoon's water at a position: positive inside it, negative on the land round it. */
function lagoonEdge(
  lagoon: Lagoon,
  settings: LagoonSettings,
  sample: { inland: number; x: number; y: number }
): number {
  return (
    sample.inland -
    lagoon.shore -
    shoreOffset(lagoon, settings, sample.x, sample.y)
  );
}

/** Whether a point lies within an inlet's bounds, where alone it can be in the inlet. */
function withinInlet(inlet: Inlet, x: number, y: number): boolean {
  const { bounds } = inlet;
  return (
    x >= bounds.left &&
    x <= bounds.right &&
    y >= bounds.top &&
    y <= bounds.bottom
  );
}

/**
 * Map units from a point to an inlet's centre line, and how far along the
 * line the nearest point lies. Callers test `withinInlet` first.
 */
function inletDistance(
  inlet: Inlet,
  x: number,
  y: number
): { along: number; distance: number } {
  let best = Number.POSITIVE_INFINITY;
  let along = 0;
  for (let index = 1; index < inlet.points.length; index += 1) {
    const [ax = 0, ay = 0] = inlet.points[index - 1] ?? [];
    const [bx = 0, by = 0] = inlet.points[index] ?? [];
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const t =
      length > 0
        ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length))
        : 0;
    const distance = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (distance < best) {
      best = distance;
      along =
        (inlet.lengths[index - 1] ?? 0) +
        t * ((inlet.lengths[index] ?? 0) - (inlet.lengths[index - 1] ?? 0));
    }
  }
  return { along, distance: best };
}

/**
 * Half an inlet's width at a distance along it: the throat's, widening to
 * the mouth's past the coast, its banks wandering outward by up to
 * `wander.share` of it by seeded noise so neither runs straight.
 */
function inletHalfWidth(
  inlet: Inlet,
  settings: LagoonSettings,
  along: number
): number {
  const { flare, wander, width } = settings.inlet;
  const opening = smoothstep(inlet.lagoon, inlet.coast + width, along);
  // The banks only widen, so the throat is never narrower than `width`.
  const banks =
    1 +
    (wander.share *
      (gradientNoise(along / wander.wavelength, 0.5, inlet.seed) + 1)) /
      2;
  return (width / 2) * (1 + (flare - 1) * opening) * banks;
}

/**
 * Nominal metres over an inlet's centre line at a distance along it: the
 * lagoon's depth where it leaves the lagoon, the inlet's own depth at the
 * coast, and past the coast fading to nothing over `reach`. The sea's own
 * floor is kept wherever it is deeper, so the channel only cuts the apron
 * where the apron is shallower than the inlet and ends in the seabed
 * without a step or a pit.
 */
function inletDepth(
  inlet: Inlet,
  settings: LagoonSettings,
  along: number,
  lagoonDepth: number
): number {
  const { depth, reach } = settings.inlet;
  if (along <= inlet.coast) {
    const t = smoothstep(inlet.lagoon, inlet.coast, along);
    return lagoonDepth + (depth - lagoonDepth) * t;
  }
  const u = (along - inlet.coast) / Math.max(reach, 1e-6);
  return depth * (1 - smoothstep(0, 1, u));
}

/** The lagoon floor's depth, nominal metres, `edge` map units into the water, before its bank and reefs. */
function floorDepth(
  lagoon: Lagoon,
  settings: LagoonSettings,
  edge: number,
  x: number,
  y: number
): number {
  const { depth, floor } = settings;
  const span = Math.max(1, lagoon.depth - lagoon.shore);
  const basin =
    depth.shore +
    (depth.centre - depth.shore) * smoothstep(0, settings.basin, edge / span);
  const relief =
    floor.amplitude *
    fbm(x / floor.wavelength, y / floor.wavelength, lagoon.seeds.floor, floor);
  return Math.max(
    depth.shore,
    basin + relief * smoothstep(0, settings.bank, edge)
  );
}

/** Water depth within the bank: `edge` at the water's edge, `full` once `bank` map units in. */
function banked(
  full: number,
  edge: number,
  bank: number,
  settings: LagoonSettings
) {
  return (
    settings.depth.edge +
    (full - settings.depth.edge) * smoothstep(0, bank, edge)
  );
}

/** A knoll's depth over a point: rising from the floor to `reefs.top` at its crest. */
function reefDepth(
  lagoon: Lagoon,
  settings: LagoonSettings,
  depth: number,
  x: number,
  y: number
): number {
  let shallowest = depth;
  for (const reef of lagoon.reefs) {
    const t = Math.hypot(x - reef.x, y - reef.y) / reef.radius;
    if (t < 1) {
      const crest =
        settings.reefs.top +
        (depth - settings.reefs.top) * smoothstep(0.25, 1, t);
      shallowest = Math.min(shallowest, crest);
    }
  }
  return shallowest;
}

/**
 * The water at a land-side position of an atoll: how far into it the
 * position lies (negative on the land round it) and the depth there in
 * nominal metres.
 */
function lagoonWater(
  lagoon: Lagoon,
  settings: LagoonSettings,
  sample: { inland: number; x: number; y: number }
): { depth: number; edge: number } {
  const { x, y } = sample;
  const lagoonAt = lagoonEdge(lagoon, settings, sample);
  let edge = lagoonAt;
  let depth = 0;
  if (lagoonAt > 0) {
    depth = banked(
      floorDepth(lagoon, settings, lagoonAt, x, y),
      lagoonAt,
      settings.bank,
      settings
    );
  }
  for (const inlet of lagoon.inlets) {
    if (!withinInlet(inlet, x, y)) {
      continue;
    }
    const { along, distance } = inletDistance(inlet, x, y);
    const inside = inletHalfWidth(inlet, settings, along) - distance;
    edge = Math.max(edge, inside);
    if (inside > 0) {
      const start = floorDepth(lagoon, settings, settings.bank, x, y);
      depth = Math.max(
        depth,
        banked(
          inletDepth(inlet, settings, along, start),
          inside,
          settings.inlet.bank,
          settings
        )
      );
    }
  }
  if (edge > 0) {
    depth = reefDepth(lagoon, settings, depth, x, y);
  }
  return { depth, edge };
}

/**
 * The deepest an inlet's channel carves a sea cell, nominal metres, or 0
 * where no channel runs: the seaward run of each inlet past the coast.
 */
export function inletChannel(
  lagoons: readonly Lagoon[],
  settings: LagoonSettings,
  x: number,
  y: number
): number {
  let deepest = 0;
  for (const lagoon of lagoons) {
    for (const inlet of lagoon.inlets) {
      // Outside the inlet's bounds there is no channel to widen.
      if (!withinInlet(inlet, x, y)) {
        continue;
      }
      const { along, distance } = inletDistance(inlet, x, y);
      const inside = inletHalfWidth(inlet, settings, along) - distance;
      if (inside > 0 && along > inlet.coast - settings.inlet.width) {
        deepest = Math.max(
          deepest,
          banked(
            inletDepth(inlet, settings, along, settings.inlet.depth),
            inside,
            settings.inlet.bank,
            settings
          )
        );
      }
    }
  }
  return deepest;
}

/** The inner beach's height `distance` map units from the water's edge, before it meets the rim. */
function innerBeach(
  distance: number,
  beachHeight: number,
  settings: LagoonSettings
): number {
  const { lip, rise, width } = settings.beach;
  if (distance <= width) {
    return beachHeight * smoothstep(0, lip, distance);
  }
  return beachHeight + (distance - width) * rise;
}

/**
 * An island landform with its atolls' lagoons carved in: below the water
 * inside a lagoon or an inlet, and held to the inner beach on the land
 * round them. Only the piece of land whose `pieceDepth` is the lagoon's
 * depth, the atoll's main land, is carved, so samples must carry their
 * piece depth. Every other island's land is the landform's own.
 */
export function lagoonLandform(
  base: Landform,
  lagoons: readonly Lagoon[],
  settings: LagoonSettings = defaultLagoonSettings
): Landform {
  const byIsland = new Map(lagoons.map((lagoon) => [lagoon.islandId, lagoon]));
  if (!byIsland.size) {
    return base;
  }
  return (sample) => {
    const height = base(sample);
    const lagoon = byIsland.get(sample.islandId);
    // Only the atoll's own piece of land holds its lagoon; its islets do not.
    if (!lagoon || (sample.pieceDepth ?? lagoon.depth) !== lagoon.depth) {
      return height;
    }
    const water = lagoonWater(lagoon, settings, sample);
    if (water.edge > 0) {
      return elevationAtDepth(water.depth);
    }
    return Math.min(
      height,
      innerBeach(-water.edge, lagoon.beachHeight, settings)
    );
  };
}

/** Unit vectors round the compass that an inlet's bearing is chosen from. */
const bearings = 64;

/** One candidate bearing for an inlet from the lagoon's centre. */
interface Bearing {
  angle: number;
  /** Map units along the bearing where it crosses the coast. */
  coast: number;
  /** Map units along the bearing where it leaves the lagoon. */
  lagoon: number;
  score: number;
}

/** What one bearing out of an atoll is walked over: the grid, the atoll and the lagoon, and the distance to other islands. */
interface Walk {
  centre: readonly [number, number];
  grid: LagoonGrid;
  island: number;
  lagoon: Pick<Lagoon, "depth" | "seeds" | "shore">;
  settings: LagoonSettings;
  toOthers: Float32Array;
}

/** A point `along` map units out on a bearing, and its grid cell, or undefined off the grid. */
function walkPoint(walk: Walk, angle: number, along: number) {
  const { centre, grid } = walk;
  const x = centre[0] + Math.cos(angle) * along;
  const y = centre[1] + Math.sin(angle) * along;
  const column = Math.floor((x - grid.left) / grid.cell);
  const row = Math.floor((y - grid.top) / grid.cell);
  if (column < 0 || row < 0 || column >= grid.width || row >= grid.height) {
    return;
  }
  return { at: row * grid.width + column, x, y };
}

/** Map units out along a bearing where it leaves the lagoon and where it crosses the coast. */
function crossings(
  walk: Walk,
  angle: number
): { coast: number; lagoon: number } | undefined {
  const { grid, lagoon, settings } = walk;
  const step = grid.cell / 2;
  let lagoonAt: number | undefined;
  for (let along = 0; along <= lagoon.depth * 4; along += step) {
    const point = walkPoint(walk, angle, along);
    if (!point) {
      return;
    }
    const inland = -sampleCells(grid, grid.signedDistance, point.x, point.y);
    if (lagoonAt === undefined) {
      const shore =
        lagoon.shore + shoreOffset(lagoon, settings, point.x, point.y);
      lagoonAt = inland <= shore ? along : undefined;
    } else if (inland <= 0) {
      return { coast: along, lagoon: lagoonAt };
    }
  }
}

/**
 * Map units of open water past the coast along a bearing: the least
 * distance to another island's land over `inlet.look`, or undefined where
 * the bearing meets the atoll's own land again.
 */
function openWater(
  walk: Walk,
  angle: number,
  coast: number
): number | undefined {
  const { grid, island, settings, toOthers } = walk;
  let open: number = settings.inlet.look;
  for (
    let along = coast;
    along <= coast + settings.inlet.look;
    along += grid.cell / 2
  ) {
    const point = walkPoint(walk, angle, along);
    if (!point) {
      break;
    }
    const own =
      (grid.signedDistance[point.at] ?? 0) < 0 &&
      grid.owner[point.at] === island;
    if (own && along > coast + grid.cell) {
      return;
    }
    open = Math.min(open, (toOthers[point.at] ?? 0) * grid.cell);
  }
  return open;
}

/**
 * Walks one bearing out of an atoll: where it leaves the lagoon, where it
 * crosses the coast, and how open the water beyond is. A bearing that
 * meets land of the atoll again, or never reaches the sea, is no inlet.
 */
function walkBearing(walk: Walk, angle: number): Bearing | undefined {
  const crossed = crossings(walk, angle);
  if (!crossed) {
    return;
  }
  const open = openWater(walk, angle, crossed.coast);
  if (open === undefined) {
    return;
  }
  return {
    angle,
    coast: crossed.coast,
    lagoon: crossed.lagoon,
    score:
      open - (crossed.coast - crossed.lagoon) / walk.settings.inlet.rimCost,
  };
}

/** An inlet's meandering centre line along a bearing, from inside the lagoon to past the coast. */
function inletLine(
  centre: readonly [number, number],
  bearing: Bearing,
  settings: LagoonSettings,
  seed: number
): Inlet {
  const { meander, reach, width } = settings.inlet;
  const start = Math.max(0, bearing.lagoon - width);
  const end = bearing.coast + reach;
  const dx = Math.cos(bearing.angle);
  const dy = Math.sin(bearing.angle);
  const phase = (latticeHash(1, 2, seed) / 4_294_967_296) * Math.PI * 2;
  const count = 24;
  const points: [number, number][] = [];
  for (let index = 0; index <= count; index += 1) {
    const t = index / count;
    const along = start + (end - start) * t;
    const sway =
      meander.amplitude *
      Math.sin(Math.PI * meander.waves * t + phase) *
      Math.sin(Math.PI * t);
    points.push([
      centre[0] + dx * along - dy * sway,
      centre[1] + dy * along + dx * sway,
    ]);
  }
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) {
    const [ax = 0, ay = 0] = points[index - 1] ?? [];
    const [bx = 0, by = 0] = points[index] ?? [];
    lengths.push((lengths[index - 1] ?? 0) + Math.hypot(bx - ax, by - ay));
  }
  const scale = (lengths.at(-1) ?? 0) / Math.max(end - start, 1e-6);
  const margin =
    (width / 2) * settings.inlet.flare * (1 + settings.inlet.wander.share);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    bounds: {
      bottom: Math.max(...ys) + margin,
      left: Math.min(...xs) - margin,
      right: Math.max(...xs) + margin,
      top: Math.min(...ys) - margin,
    },
    coast: (bearing.coast - start) * scale,
    lagoon: (bearing.lagoon - start) * scale,
    lengths,
    points,
    seed,
  };
}

/**
 * Cells from every cell to land of any island but one, measured over a
 * window `reach` map units round the island's own land. Near the window's
 * edge a cell reads no farther than the edge, and beyond the window 0, so
 * land the window misses is never taken for open water.
 */
function distanceToOthers(
  grid: LagoonGrid,
  island: number,
  reach: number
): Float32Array {
  let left = grid.width;
  let right = -1;
  let top = grid.height;
  let bottom = -1;
  for (let at = 0; at < grid.owner.length; at += 1) {
    if (grid.owner[at] === island) {
      const column = at % grid.width;
      const row = (at - column) / grid.width;
      left = Math.min(left, column);
      right = Math.max(right, column);
      top = Math.min(top, row);
      bottom = Math.max(bottom, row);
    }
  }
  const margin = Math.ceil(reach / grid.cell);
  left = Math.max(0, left - margin);
  top = Math.max(0, top - margin);
  right = Math.min(grid.width - 1, right + margin);
  bottom = Math.min(grid.height - 1, bottom + margin);
  const width = Math.max(1, right - left + 1);
  const height = Math.max(1, bottom - top + 1);
  const land = new Uint8Array(width * height);
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const at = (r + top) * grid.width + c + left;
      land[r * width + c] =
        (grid.signedDistance[at] ?? 0) < 0 && grid.owner[at] !== island ? 1 : 0;
    }
  }
  const window = shoreDistances(land, width, height);
  const distances = new Float32Array(grid.width * grid.height);
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      // Land beyond the window may lie just past its edge.
      distances[(r + top) * grid.width + c + left] = Math.min(
        window[r * width + c] ?? 0,
        Math.min(r, c, height - 1 - r, width - 1 - c) + 1
      );
    }
  }
  return distances;
}

/** Seeded patch reefs inside a lagoon, one candidate cell per `spacing` of its area, kept apart. */
function patchReefs(
  grid: LagoonGrid,
  cells: readonly number[],
  lagoon: Pick<Lagoon, "depth" | "seeds" | "shore">,
  settings: LagoonSettings,
  seed: number
): Lagoon["reefs"] {
  const area = cells.length * grid.cell ** 2;
  const wanted = Math.floor(area / settings.reefs.spacing);
  const reefs: { radius: number; x: number; y: number }[] = [];
  const { max, min } = settings.reefs.radius;
  for (
    let attempt = 0;
    attempt < wanted * 6 && reefs.length < wanted;
    attempt += 1
  ) {
    const pick = latticeHash(attempt, 7, seed) % cells.length;
    const at = cells[pick] ?? 0;
    const column = at % grid.width;
    const row = (at - column) / grid.width;
    const x = grid.left + (column + 0.5) * grid.cell;
    const y = grid.top + (row + 0.5) * grid.cell;
    const radius =
      min + ((max - min) * latticeHash(attempt, 11, seed)) / 4_294_967_296;
    // Clear of the shore's bank and of every other reef.
    const edge =
      -(grid.signedDistance[at] ?? 0) -
      lagoon.shore -
      shoreOffset(lagoon, settings, x, y);
    const apart = reefs.every(
      (reef) =>
        Math.hypot(reef.x - x, reef.y - y) > 2.5 * (reef.radius + radius)
    );
    if (edge > settings.bank + radius && apart) {
      reefs.push({ radius, x, y });
    }
  }
  return reefs;
}

/** The atoll's deepest cell and its depth, or undefined where it has no land. */
function deepestCell(grid: LagoonGrid, island: number) {
  let deepest = -1;
  let depth = 0;
  for (let at = 0; at < grid.owner.length; at += 1) {
    const inland = -(grid.signedDistance[at] ?? 0);
    if (grid.owner[at] === island && inland > depth) {
      depth = inland;
      deepest = at;
    }
  }
  return deepest < 0 ? undefined : { at: deepest, depth };
}

/** The atoll's cells past its lagoon's shore. */
function lagoonCells(
  grid: LagoonGrid,
  island: number,
  plan: Pick<Lagoon, "seeds" | "shore">,
  settings: LagoonSettings
): number[] {
  const cells: number[] = [];
  for (let at = 0; at < grid.owner.length; at += 1) {
    if (grid.owner[at] !== island) {
      continue;
    }
    const x = grid.left + ((at % grid.width) + 0.5) * grid.cell;
    const y = grid.top + (Math.floor(at / grid.width) + 0.5) * grid.cell;
    const inland = -(grid.signedDistance[at] ?? 0);
    if (inland > plan.shore + shoreOffset(plan, settings, x, y)) {
      cells.push(at);
    }
  }
  return cells;
}

/** The best bearing, and for a large lagoon the best a third of the compass or more round from it. */
function chooseBearings(
  candidates: readonly Bearing[],
  large: boolean
): Bearing[] {
  const [first] = candidates;
  if (!first) {
    return [];
  }
  const apart = (bearing: Bearing) =>
    Math.abs(
      ((bearing.angle - first.angle + 3 * Math.PI) % (2 * Math.PI)) - Math.PI
    ) >=
    (2 * Math.PI) / 3;
  const second = large ? candidates.find(apart) : undefined;
  return second ? [first, second] : [first];
}

/** One atoll's lagoon, or none where it is too shallow for water past its shore. */
function planLagoon(
  grid: LagoonGrid,
  site: LagoonSite,
  settings: LagoonSettings
): Lagoon | undefined {
  const island = grid.islandIds.indexOf(site.islandId);
  const deepest = island < 0 ? undefined : deepestCell(grid, island);
  if (!deepest || deepest.depth <= site.shore + settings.bank) {
    return;
  }
  const seeds = {
    floor: noiseSeed(`${settings.seed}:${site.islandId}:floor`),
    shore: noiseSeed(`${settings.seed}:${site.islandId}:shore`),
  };
  const plan = { ...site, depth: deepest.depth, seeds };
  const centre: [number, number] = [
    grid.left + ((deepest.at % grid.width) + 0.5) * grid.cell,
    grid.top + (Math.floor(deepest.at / grid.width) + 0.5) * grid.cell,
  ];
  const cells = lagoonCells(grid, island, plan, settings);
  const walk: Walk = {
    centre,
    grid,
    island,
    lagoon: plan,
    settings,
    toOthers: distanceToOthers(
      grid,
      island,
      deepest.depth * 4 + settings.inlet.look + 2 * grid.cell
    ),
  };
  const candidates = Array.from({ length: bearings }, (_, index) =>
    walkBearing(walk, (index / bearings) * Math.PI * 2)
  )
    .filter((bearing): bearing is Bearing => bearing !== undefined)
    .sort((a, b) => b.score - a.score || a.angle - b.angle);
  const large = cells.length * grid.cell ** 2 >= settings.inlet.largeArea;
  const inletSeed = noiseSeed(`${settings.seed}:${site.islandId}:inlet`);
  return {
    ...plan,
    inlets: chooseBearings(candidates, large).map((bearing, index) =>
      inletLine(centre, bearing, settings, inletSeed + index)
    ),
    reefs: patchReefs(grid, cells, plan, settings, inletSeed),
  };
}

/**
 * Plans each atoll's lagoon over the preview's coast distance: the
 * deepest cell of the atoll's land is its centre, and an inlet takes the
 * bearing from it whose coast opens on the clearest water, away from
 * other islands, at the least cost of rim to cut. A lagoon of at least
 * `inlet.largeArea` takes a second inlet at least a third of the compass
 * round from the first. An atoll too shallow for water past its shore has
 * no lagoon.
 */
export function planLagoons(
  grid: LagoonGrid,
  sites: readonly LagoonSite[],
  settings: LagoonSettings = defaultLagoonSettings
): Lagoon[] {
  return [...sites]
    .sort((a, b) => a.islandId.localeCompare(b.islandId))
    .flatMap((site) => {
      const lagoon = planLagoon(grid, site, settings);
      return lagoon ? [lagoon] : [];
    });
}
