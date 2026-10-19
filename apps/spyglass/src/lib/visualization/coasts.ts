import { contours } from "d3-contour";
import { shoreDistances } from "./distance-field";
import type { GeologyGrid } from "./geology";
import {
  domainWarp,
  type FractalSettings,
  fbm,
  noiseSeed,
  ridgedFbm,
  type WarpSettings,
} from "./noise";
import { fillPolygon } from "./scanline-fill";
import type { TerrainIsland } from "./terrain";
import type { Polygon } from "./types";

/**
 * The preview's coasts: each island's surveyed coast, cleaned and sculpted
 * on a fine raster of its own and traced back into polygons. Small enclosed
 * pools are filled; a small islet near a larger piece of its island is
 * joined to it by a sandbar, and every other islet is kept as a cay no
 * smaller than a set radius; and seeded noise moves the coast a little out
 * and in, for bays, headlands, coves and spits. An island never grows
 * nearer another island's surveyed coast than `clearance`, so two islands
 * never merge. The polygons share the surveyed coasts' shape, island-local
 * map units, so anything that reads a coast reads these. The default map
 * keeps the surveyed coasts; only the geology preview reads these.
 */
export interface CoastSettings {
  /** Map units kept between one island's coast and another island's surveyed coast: no land grows nearer. */
  clearance: number;
  /**
   * Map units round each of an island's files that the coast never moves
   * in across: surveyed land that near a file stays land, so a file near
   * its coast is never drowned.
   */
  fileClearance: number;
  /** Enclosed water of at most this many square map units is filled: a pool in the land, never a lagoon. */
  holeArea: number;
  /** Small pieces of land: which count as islets, which join their island, and how small a cay may be. */
  islets: {
    /** Pieces of at most this many square map units are islets. */
    area: number;
    /** Map units over which a sandbar flares into the land at either end. */
    flare: number;
    /** Smallest radius, in map units, a cay is grown to. */
    radius: number;
    /** An islet at most this many map units from a larger piece of its island joins it by a sandbar. */
    reach: number;
    /** Map units across a sandbar at its waist. */
    width: number;
  };
  /** Map units per cell of the raster each coast is cleaned and sculpted on. */
  resolution: number;
  /**
   * The coast's movement. Warped fBm gives bays and headlands; its value,
   * scaled by `contrast` and held within -1 to 1, moves the coast out by up
   * to `outward` map units or in by up to `inward`. A finer field bites the
   * odd rounded cove inward where it passes `coves.threshold`, and ridged
   * noise draws the odd spit outward where its crests pass
   * `spits.threshold`. A piece
   * moves in by at most `inwardShare` of its depth, so a small one survives.
   */
  sculpt: FractalSettings & {
    contrast: number;
    coves: FractalSettings & {
      /** Share of the inward movement a cove cuts at full strength. */
      amplitude: number;
      threshold: number;
      wavelength: number;
    };
    inward: number;
    inwardShare: number;
    outward: number;
    spits: FractalSettings & {
      /** Share of the outward movement a spit adds at full strength. */
      amplitude: number;
      threshold: number;
      wavelength: number;
    };
    warp: FractalSettings & { amplitude: number; wavelength: number };
    /** Map units per lattice cell of the bays and headlands. */
    wavelength: number;
  };
  /** Seeds every noise field, with each island's id. */
  seed: string;
}

export const defaultCoastSettings: CoastSettings = {
  clearance: 14,
  fileClearance: 3,
  holeArea: 400,
  islets: { area: 900, flare: 5, radius: 7, reach: 16, width: 5 },
  resolution: 2,
  sculpt: {
    contrast: 1.7,
    coves: {
      amplitude: 0.9,
      gain: 0.5,
      lacunarity: 2,
      octaves: 1,
      threshold: 0.3,
      wavelength: 20,
    },
    gain: 0.45,
    inward: 4,
    inwardShare: 0.3,
    lacunarity: 2,
    octaves: 3,
    outward: 6,
    spits: {
      amplitude: 0.4,
      gain: 0.5,
      lacunarity: 2,
      octaves: 1,
      threshold: 0.5,
      wavelength: 70,
    },
    warp: {
      amplitude: 14,
      gain: 0.5,
      lacunarity: 2,
      octaves: 2,
      wavelength: 90,
    },
    wavelength: 46,
  },
  seed: "spyglass:coast",
};

/** An island whose coast is cleaned: optionally with its files, in island-local map units, kept on land. */
export interface CoastIsland extends TerrainIsland {
  files?: readonly { x: number; y: number }[];
}

/** A raster over map units: its north-west corner, size in cells, and map units per cell. */
interface Frame {
  height: number;
  left: number;
  resolution: number;
  top: number;
  width: number;
}

/** One connected piece of land on a raster. */
interface Piece {
  /** Cells it covers. */
  area: number;
  /** Cells on its edge: a 4-neighbour is water. */
  border: number[];
  /** Map units inland of its deepest cell. */
  depth: number;
  x: number;
  y: number;
}

/** An island's coast as the structural terrain reads it: a circle of its radius where it has none. */
function surveyedCoast(island: TerrainIsland): readonly Polygon[] {
  if (island.coast.length) {
    return island.coast;
  }
  const radius = Math.max(1, island.radius);
  const ring: [number, number][] = Array.from({ length: 32 }, (_, i) => [
    Math.cos((i * Math.PI) / 16) * radius,
    Math.sin((i * Math.PI) / 16) * radius,
  ]);
  return [[ring]];
}

/** Map-unit bounds of an island's coast. */
function coastBounds(island: TerrainIsland) {
  const points = surveyedCoast(island).flatMap((polygon) => polygon[0] ?? []);
  const xs = points.map(([x]) => island.x + x);
  const ys = points.map(([, y]) => island.y + y);
  return {
    bottom: Math.max(...ys),
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
  };
}

/** Fills an island's coast into a raster's cells. */
function fillCoast(mask: Uint8Array, frame: Frame, island: TerrainIsland) {
  for (const polygon of surveyedCoast(island)) {
    fillPolygon(
      mask,
      frame.width,
      frame.height,
      polygon.map((ring) =>
        ring.map(([x, y]): [number, number] => [
          (island.x + x - frame.left) / frame.resolution,
          (island.y + y - frame.top) / frame.resolution,
        ])
      )
    );
  }
}

/** The cells a mask's land covers, as a window one cell wider all round, clamped to the raster. */
function landWindow(land: Uint8Array, width: number, height: number) {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let at = 0; at < land.length; at += 1) {
    if (land[at]) {
      const column = at % width;
      const row = (at - column) / width;
      left = Math.min(left, column);
      right = Math.max(right, column);
      top = Math.min(top, row);
      bottom = Math.max(bottom, row);
    }
  }
  if (right < 0) {
    return;
  }
  return {
    bottom: Math.min(height - 1, bottom + 1),
    left: Math.max(0, left - 1),
    right: Math.min(width - 1, right + 1),
    top: Math.max(0, top - 1),
  };
}

/**
 * Map units from each cell's centre to the coast between land and water,
 * negative on land: the distance transform on either side, less the half
 * cell between a centre and the boundary, as the structural terrain
 * measures its coasts. Distances inland are measured over the land's own
 * window and a cell of water round it: no water beyond is nearer.
 */
export function maskDistance(
  land: Uint8Array,
  width: number,
  height: number,
  cell: number
): Float32Array {
  const outside = shoreDistances(land, width, height);
  const distance = Float32Array.from(
    outside,
    (value) => Math.max(0, value - 0.5) * cell
  );
  const window = landWindow(land, width, height);
  if (!window) {
    return distance;
  }
  const innerWidth = window.right - window.left + 1;
  const innerHeight = window.bottom - window.top + 1;
  const water = new Uint8Array(innerWidth * innerHeight);
  for (let r = 0; r < innerHeight; r += 1) {
    for (let c = 0; c < innerWidth; c += 1) {
      water[r * innerWidth + c] =
        1 - (land[(r + window.top) * width + c + window.left] ?? 0);
    }
  }
  const inside = shoreDistances(water, innerWidth, innerHeight);
  for (let r = 0; r < innerHeight; r += 1) {
    for (let c = 0; c < innerWidth; c += 1) {
      const at = (r + window.top) * width + c + window.left;
      if (land[at]) {
        distance[at] =
          -Math.max(0, (inside[r * innerWidth + c] ?? 0) - 0.5) * cell;
      }
    }
  }
  return distance;
}

/**
 * Labels the 4-connected cells of one kind (`kind` 1 for land, 0 for
 * water), each component's cells listed by label. 4-connected water and
 * 8-connected land would agree on topology; water's 4-connectivity is what
 * a pool needs.
 */
function components(
  mask: Uint8Array,
  width: number,
  height: number,
  kind: number,
  diagonal: boolean
): { cells: number[][]; label: Int32Array } {
  const label = new Int32Array(mask.length).fill(-1);
  const cells: number[][] = [];
  const stack: number[] = [];
  const steps = diagonal
    ? [
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
        [1, 1],
      ]
    : [
        [0, -1],
        [-1, 0],
        [1, 0],
        [0, 1],
      ];
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== kind || label[start] !== -1) {
      continue;
    }
    const id = cells.length;
    const members: number[] = [];
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const at = stack.pop() as number;
      members.push(at);
      const column = at % width;
      const row = (at - column) / width;
      for (const [dx = 0, dy = 0] of steps) {
        const c = column + dx;
        const r = row + dy;
        if (c < 0 || r < 0 || c >= width || r >= height) {
          continue;
        }
        const next = r * width + c;
        if (mask[next] === kind && label[next] === -1) {
          label[next] = id;
          stack.push(next);
        }
      }
    }
    cells.push(members);
  }
  return { cells, label };
}

/**
 * Sets every enclosed pocket of water (cells where `isWater`) of at most
 * `most` cells to land via `fill`. The open water is flooded from the
 * raster's edge first, 4-connected, so only the pockets are labelled.
 */
function fillPockets(
  isWater: Uint8Array,
  width: number,
  height: number,
  most: number,
  fill: (at: number) => void
): void {
  const open = new Uint8Array(isWater.length);
  const queue = new Int32Array(isWater.length);
  let head = 0;
  let tail = 0;
  const visit = (at: number) => {
    if (isWater[at] && !open[at]) {
      open[at] = 1;
      queue[tail] = at;
      tail += 1;
    }
  };
  for (let column = 0; column < width; column += 1) {
    visit(column);
    visit((height - 1) * width + column);
  }
  for (let row = 0; row < height; row += 1) {
    visit(row * width);
    visit(row * width + width - 1);
  }
  while (head < tail) {
    const at = queue[head] as number;
    head += 1;
    const column = at % width;
    if (column > 0) {
      visit(at - 1);
    }
    if (column < width - 1) {
      visit(at + 1);
    }
    if (at >= width) {
      visit(at - width);
    }
    if (at < (height - 1) * width) {
      visit(at + width);
    }
  }
  const enclosed = Uint8Array.from(isWater, (water, at) =>
    water && !open[at] ? 1 : 0
  );
  const { cells } = components(enclosed, width, height, 1, false);
  for (const pocket of cells) {
    if (pocket.length <= most) {
      for (const at of pocket) {
        fill(at);
      }
    }
  }
}

/** Each 8-connected piece of land: its cells, edge, depth and centre. */
function landPieces(
  land: Uint8Array,
  distance: Float32Array,
  frame: Frame
): { label: Int32Array; pieces: Piece[] } {
  const { width, height, resolution } = frame;
  const { cells, label } = components(land, width, height, 1, true);
  const pieces = cells.map((members): Piece => {
    let depth = 0;
    let sx = 0;
    let sy = 0;
    const border: number[] = [];
    for (const at of members) {
      const column = at % width;
      const row = (at - column) / width;
      depth = Math.max(depth, -(distance[at] ?? 0));
      sx += column;
      sy += row;
      const edge =
        column === 0 ||
        row === 0 ||
        column === width - 1 ||
        row === height - 1 ||
        !land[at - 1] ||
        !land[at + 1] ||
        !land[at - width] ||
        !land[at + width];
      if (edge) {
        border.push(at);
      }
    }
    return {
      area: members.length,
      border,
      depth,
      x: frame.left + (sx / members.length + 0.5) * resolution,
      y: frame.top + (sy / members.length + 0.5) * resolution,
    };
  });
  return { label, pieces };
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** A polynomial smooth minimum: exact where `a` and `b` differ by `k` or more. */
function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) {
    return Math.min(a, b);
  }
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

/** One island's coast movement at a map position, -1 (fully in) to 1 (fully out). */
function coastNoise(
  island: TerrainIsland,
  settings: CoastSettings
): (x: number, y: number) => number {
  const { sculpt } = settings;
  const seeds = {
    bays: noiseSeed(`${settings.seed}:${island.id}:bays`),
    coves: noiseSeed(`${settings.seed}:${island.id}:coves`),
    spits: noiseSeed(`${settings.seed}:${island.id}:spits`),
    warp: noiseSeed(`${settings.seed}:${island.id}:warp`),
  };
  const warp: WarpSettings = {
    ...sculpt.warp,
    frequency: 1 / sculpt.warp.wavelength,
  };
  return (x, y) => {
    const [wx, wy] = domainWarp(x, y, seeds.warp, warp);
    let value =
      sculpt.contrast *
      fbm(wx / sculpt.wavelength, wy / sculpt.wavelength, seeds.bays, sculpt);
    // Coves are rounded bites where a finer field passes its threshold.
    const cove = fbm(
      wx / sculpt.coves.wavelength,
      wy / sculpt.coves.wavelength,
      seeds.coves,
      sculpt.coves
    );
    value -=
      sculpt.coves.amplitude * smoothstep(sculpt.coves.threshold, 1, cove);
    const spit = ridgedFbm(
      wx / sculpt.spits.wavelength,
      wy / sculpt.spits.wavelength,
      seeds.spits,
      sculpt.spits
    );
    value +=
      sculpt.spits.amplitude * smoothstep(sculpt.spits.threshold, 1, spit);
    return Math.min(1, Math.max(-1, value));
  };
}

/** Map units from a point to a segment, and where along it, 0 to 1, the nearest point lies. */
function segmentDistance(
  x: number,
  y: number,
  a: readonly [number, number],
  b: readonly [number, number]
): { along: number; distance: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const along =
    length > 0
      ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / length))
      : 0;
  return {
    along,
    distance: Math.hypot(x - a[0] - along * dx, y - a[1] - along * dy),
  };
}

/** A sandbar: the segment it runs along, from an islet to the land it joins. */
type Bar = readonly [readonly [number, number], readonly [number, number]];

/** A raster cell's centre in map units. */
function cellCentre(frame: Frame, at: number): [number, number] {
  const column = at % frame.width;
  const row = (at - column) / frame.width;
  return [
    frame.left + (column + 0.5) * frame.resolution,
    frame.top + (row + 0.5) * frame.resolution,
  ];
}

/** The nearest pair of edge cells between an islet and any larger piece, as map positions and their gap. */
function nearestGap(
  islet: Piece,
  pieces: readonly Piece[],
  frame: Frame
): { from: [number, number]; gap: number; to: [number, number] } {
  const nearest = {
    from: [0, 0] as [number, number],
    gap: Number.POSITIVE_INFINITY,
    to: [0, 0] as [number, number],
  };
  const larger = pieces
    .filter((other) => other.area > islet.area)
    .flatMap((other) => other.border.map((at) => cellCentre(frame, at)));
  for (const a of islet.border) {
    const pa = cellCentre(frame, a);
    for (const pb of larger) {
      const gap = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      if (gap < nearest.gap) {
        nearest.gap = gap;
        nearest.from = pa;
        nearest.to = pb;
      }
    }
  }
  return nearest;
}

/**
 * Sandbars from each islet to the nearest larger piece of its island,
 * where the gap is at most `islets.reach`: between their two nearest edge
 * cells, each end carried two cells into the land.
 */
function sandbars(
  pieces: readonly Piece[],
  frame: Frame,
  settings: CoastSettings
): Bar[] {
  const { resolution } = frame;
  const isletCells = settings.islets.area / resolution ** 2;
  return pieces
    .filter((islet) => islet.area <= isletCells)
    .flatMap((islet) => {
      const { from, gap, to } = nearestGap(islet, pieces, frame);
      if (gap === 0 || gap - resolution > settings.islets.reach) {
        return [];
      }
      const ux = (to[0] - from[0]) / gap;
      const uy = (to[1] - from[1]) / gap;
      const into = 2 * resolution;
      const bar: Bar = [
        [from[0] - ux * into, from[1] - uy * into],
        [to[0] + ux * into, to[1] + uy * into],
      ];
      return [bar];
    });
}

/**
 * Map units from each cell to the nearest of an island's files, less
 * `fileClearance`, stamped only near the files; elsewhere infinite.
 */
function fileField(
  island: CoastIsland,
  frame: Frame,
  clearance: number
): Float32Array | undefined {
  if (!island.files?.length || clearance <= 0) {
    return;
  }
  const field = new Float32Array(frame.width * frame.height).fill(
    Number.POSITIVE_INFINITY
  );
  const reach = Math.ceil(clearance / frame.resolution) + 1;
  for (const file of island.files) {
    const x = island.x + file.x;
    const y = island.y + file.y;
    const column = Math.floor((x - frame.left) / frame.resolution);
    const row = Math.floor((y - frame.top) / frame.resolution);
    for (
      let r = Math.max(0, row - reach);
      r <= Math.min(frame.height - 1, row + reach);
      r += 1
    ) {
      for (
        let c = Math.max(0, column - reach);
        c <= Math.min(frame.width - 1, column + reach);
        c += 1
      ) {
        const at = r * frame.width + c;
        const distance =
          Math.hypot(
            frame.left + (c + 0.5) * frame.resolution - x,
            frame.top + (r + 0.5) * frame.resolution - y
          ) - clearance;
        field[at] = Math.min(field[at] ?? distance, distance);
      }
    }
  }
  return field;
}

/** The raster an island's coast is cleaned on: its coast's bounds with room to grow and to see its neighbours. */
function islandFrame(island: TerrainIsland, settings: CoastSettings): Frame {
  const resolution = Math.max(0.25, settings.resolution);
  const bounds = coastBounds(island);
  const margin =
    Math.max(settings.sculpt.outward, settings.islets.radius) +
    settings.clearance +
    3 * resolution;
  const left = Math.floor((bounds.left - margin) / resolution) * resolution;
  const top = Math.floor((bounds.top - margin) / resolution) * resolution;
  return {
    height: Math.ceil((bounds.bottom + margin - top) / resolution),
    left,
    resolution,
    top,
    width: Math.ceil((bounds.right + margin - left) / resolution),
  };
}

/** An island's surveyed land on its raster, its small pools filled. */
function cleanedLand(
  island: TerrainIsland,
  frame: Frame,
  settings: CoastSettings
): Uint8Array {
  const land = new Uint8Array(frame.width * frame.height);
  fillCoast(land, frame, island);
  fillPockets(
    Uint8Array.from(land, (value) => 1 - value),
    frame.width,
    frame.height,
    settings.holeArea / frame.resolution ** 2,
    (at) => {
      land[at] = 1;
    }
  );
  return land;
}

/** Map units from each cell to the surveyed land of any other island that reaches the raster. */
function othersDistance(
  others: readonly TerrainIsland[],
  frame: Frame
): Float32Array | undefined {
  const right = frame.left + frame.width * frame.resolution;
  const bottom = frame.top + frame.height * frame.resolution;
  const near = others.filter((other) => {
    const b = coastBounds(other);
    return (
      b.right >= frame.left &&
      b.left <= right &&
      b.bottom >= frame.top &&
      b.top <= bottom
    );
  });
  if (!near.length) {
    return;
  }
  const theirs = new Uint8Array(frame.width * frame.height);
  for (const other of near) {
    fillCoast(theirs, frame, other);
  }
  return maskDistance(theirs, frame.width, frame.height, frame.resolution);
}

/** Everything one island's coast field is shaped by, per raster cell. */
interface CoastShaping {
  bars: readonly Bar[];
  cays: readonly Piece[];
  /** Surveyed coast distance, its pools filled. */
  distance: Float32Array;
  files: Float32Array | undefined;
  label: Int32Array;
  noise: (x: number, y: number) => number;
  pieces: readonly Piece[];
  settings: CoastSettings;
  toOthers: Float32Array | undefined;
}

/** The surveyed distance moved by the coast's noise, out by up to `outward`, in by up to `inward` or less on a small piece. */
function sculpted(shaping: CoastShaping, at: number, x: number, y: number) {
  const { sculpt } = shaping.settings;
  const surveyed = shaping.distance[at] ?? 0;
  const band = sculpt.outward + sculpt.inward + 2 * shaping.settings.resolution;
  if (Math.abs(surveyed) >= band) {
    return surveyed;
  }
  const n = shaping.noise(x, y);
  const piece = shaping.pieces[shaping.label[at] ?? -1];
  const inward = piece
    ? Math.min(sculpt.inward, sculpt.inwardShare * piece.depth)
    : sculpt.inward;
  return surveyed - (n > 0 ? n * sculpt.outward : n * inward);
}

/** A field joined with every cay's smallest disc and every sandbar, waisted between its flared ends. */
function withIslets(
  shaping: CoastShaping,
  value: number,
  x: number,
  y: number
): number {
  const { islets } = shaping.settings;
  if (value >= islets.radius + islets.reach) {
    return value;
  }
  let joined = value;
  for (const cay of shaping.cays) {
    joined = Math.min(joined, Math.hypot(x - cay.x, y - cay.y) - islets.radius);
  }
  for (const [a, b] of shaping.bars) {
    const { along, distance } = segmentDistance(x, y, a, b);
    const half = (islets.width / 2) * (1 + 0.5 * (2 * along - 1) ** 2);
    joined = smoothMin(joined, distance - half, islets.flare);
  }
  return joined;
}

/** One cell of the coast field: sculpted, joined with its islets, its files' land kept, and held clear of other islands. */
function shapedAt(shaping: CoastShaping, at: number, x: number, y: number) {
  const surveyed = shaping.distance[at] ?? 0;
  let value = withIslets(shaping, sculpted(shaping, at, x, y), x, y);
  if (shaping.files) {
    // Surveyed land near a file stays land.
    value = Math.min(
      value,
      Math.max(shaping.files[at] ?? Number.POSITIVE_INFINITY, surveyed)
    );
  }
  if (shaping.toOthers) {
    // No land grows within the clearance of another island.
    value = Math.max(
      value,
      Math.min(
        surveyed,
        shaping.settings.clearance - (shaping.toOthers[at] ?? 0)
      )
    );
  }
  return value;
}

/** The cleaned and sculpted coast field of one island, map units, negative on land. */
function coastField(
  island: CoastIsland,
  others: readonly TerrainIsland[],
  settings: CoastSettings
): { field: Float32Array; frame: Frame } {
  const frame = islandFrame(island, settings);
  const { height, resolution, width } = frame;
  const land = cleanedLand(island, frame, settings);
  const distance = maskDistance(land, width, height, resolution);
  const { label, pieces } = landPieces(land, distance, frame);
  const isletCells = settings.islets.area / resolution ** 2;
  const shaping: CoastShaping = {
    bars: sandbars(pieces, frame, settings),
    cays: pieces.filter((piece) => piece.area <= isletCells),
    distance,
    files: fileField(island, frame, settings.fileClearance),
    label,
    noise: coastNoise(island, settings),
    pieces,
    settings,
    toOthers: othersDistance(others, frame),
  };
  const field = new Float32Array(width * height);
  for (let at = 0; at < field.length; at += 1) {
    const [x, y] = cellCentre(frame, at);
    field[at] = shapedAt(shaping, at, x, y);
  }
  fillPockets(
    Uint8Array.from(field, (value) => (value >= 0 ? 1 : 0)),
    width,
    height,
    settings.holeArea / resolution ** 2,
    (at) => {
      field[at] = -resolution / 2;
    }
  );
  return { field, frame };
}

/** Twice a ring's signed area, by the shoelace formula. */
function ringArea(ring: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (const [i, [x0, y0]] of ring.entries()) {
    const [x1, y1] = ring[(i + 1) % ring.length] ?? [x0, y0];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

/** Specks of land smaller than this many square map units, left by the noise, are dropped. */
const speckArea = 6;

/** The zero contour of a coast field, as polygons in the island's own map units. */
function traceCoast(
  field: Float32Array,
  frame: Frame,
  island: TerrainIsland
): Polygon[] {
  const [contour] = contours()
    .size([frame.width, frame.height])
    .thresholds([0])(Array.from(field, (value) => -value));
  return (contour?.coordinates ?? [])
    .map((polygon) =>
      polygon.map((ring) =>
        ring.map(([u = 0, v = 0]): [number, number] => [
          frame.left + u * frame.resolution - island.x,
          frame.top + v * frame.resolution - island.y,
        ])
      )
    )
    .filter((polygon) => ringArea(polygon[0] ?? []) >= speckArea);
}

/**
 * Every island with its preview coast: cleaned, sculpted and traced from
 * its surveyed coast, every file it lists kept on land. Ids, positions and
 * radii are kept, files are not carried on; islands are
 * returned in the order given, and each is seeded by its own id, so the
 * result is deterministic.
 */
export function previewCoasts(
  islands: readonly CoastIsland[],
  settings: CoastSettings = defaultCoastSettings
): TerrainIsland[] {
  return islands.map((island) => {
    const others = islands.filter((other) => other.id !== island.id);
    const { field, frame } = coastField(island, others, settings);
    return {
      coast: traceCoast(field, frame, island),
      id: island.id,
      radius: island.radius,
      x: island.x,
      y: island.y,
    };
  });
}

/**
 * The land of a set of coasts on a grid: a cell is land where its centre
 * lies inside any island's coast. With `holeArea`, enclosed water of at
 * most that many square map units is land too: a cove whose mouth is
 * narrower than a cell closes on a coarse grid, and is filled rather than
 * left as a pool.
 */
export function coastMask(
  grid: GeologyGrid,
  islands: readonly TerrainIsland[],
  holeArea = 0
): Uint8Array {
  const mask = new Uint8Array(grid.width * grid.height);
  const frame: Frame = { ...grid, resolution: grid.cell };
  for (const island of islands) {
    fillCoast(mask, frame, island);
  }
  if (holeArea > 0) {
    fillPockets(
      Uint8Array.from(mask, (value) => 1 - value),
      grid.width,
      grid.height,
      holeArea / grid.cell ** 2,
      (at) => {
        mask[at] = 1;
      }
    );
  }
  return mask;
}

/**
 * Each land cell's piece depth: map units inland of the deepest cell of
 * the 8-connected piece of land it lies on. Water cells read 0.
 */
export function pieceDepths(
  grid: GeologyGrid,
  signedDistance: ArrayLike<number>
): Float32Array {
  const depths = new Float32Array(grid.width * grid.height);
  const land = new Uint8Array(depths.length);
  for (let at = 0; at < land.length; at += 1) {
    land[at] = (signedDistance[at] ?? 0) < 0 ? 1 : 0;
  }
  const window = landWindow(land, grid.width, grid.height);
  if (!window) {
    return depths;
  }
  const width = window.right - window.left + 1;
  const height = window.bottom - window.top + 1;
  const cropped = new Uint8Array(width * height);
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      cropped[r * width + c] =
        land[(r + window.top) * grid.width + c + window.left] ?? 0;
    }
  }
  const global = (at: number) =>
    (Math.floor(at / width) + window.top) * grid.width +
    (at % width) +
    window.left;
  const { cells } = components(cropped, width, height, 1, true);
  for (const members of cells) {
    let deepest = 0;
    for (const at of members) {
      deepest = Math.max(deepest, -(signedDistance[global(at)] ?? 0));
    }
    for (const at of members) {
      depths[global(at)] = deepest;
    }
  }
  return depths;
}
