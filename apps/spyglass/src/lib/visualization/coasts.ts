import { contours } from "d3-contour";
import { shoreDistances } from "./distance-field";
import {
  elevationAtDepth,
  type GeologyGrid,
  type SeabedContribution,
} from "./geology";
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
 * pools are filled; an islet all but touching a larger piece of its island
 * is joined to it by a broad sand saddle, and every other islet is kept as
 * a round cay no smaller than a set radius, the water between it and its
 * land kept open over a submerged sand bank; and seeded noise moves the
 * coast a little out and in, for bays, headlands, coves and spits. An island never grows
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
  /**
   * Small pieces of land: which count as islets, which join their island,
   * and how a cay keeps apart from it.
   */
  islets: {
    /** Pieces of at most this many square map units are islets. */
    area: number;
    /**
     * The submerged sand bank between a cay and the land it lies off: its
     * crest `depth` nominal metres under the water, `width` map units
     * across at its waist and broader where it meets either shore.
     */
    bank: { depth: number; width: number };
    /**
     * The water kept open between a cay and the land it lies off: `share`
     * of the surveyed gap, and never less than `least` map units, its
     * shores rounded over `blend` map units where it trims the land.
     */
    channel: { blend: number; least: number; share: number };
    /** An islet at most this many map units of water from a larger piece of its island joins it by a sand saddle. */
    join: number;
    /** Map units the coast round an islet moves out at most, so a cay stays round. */
    outward: number;
    /** Smallest radius, in map units, a cay is grown to. */
    radius: number;
    /** A cay at most this many map units of water from a larger piece of its island has a sand bank to it. */
    reach: number;
    /**
     * The sand saddle that joins an islet: its waist's half width `share`
     * of the islet's radius and at least half `width` map units, blended
     * into the land over `flare` map units so its flanks curve in.
     */
    saddle: { flare: number; share: number; width: number };
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
  islets: {
    area: 900,
    bank: { depth: 3.5, width: 10 },
    channel: { blend: 3, least: 3, share: 0.6 },
    join: 4,
    outward: 2,
    radius: 7,
    reach: 16,
    saddle: { flare: 8, share: 0.9, width: 5 },
  },
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
  const distance = shoreDistances(land, width, height);
  for (let at = 0; at < distance.length; at += 1) {
    distance[at] = Math.max(0, (distance[at] ?? 0) - 0.5) * cell;
  }
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

/** The eight steps to a cell's neighbours, diagonals among them. */
const neighbourSteps = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const;

/** The four steps to a cell's edge neighbours. */
const edgeSteps = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
] as const;

/**
 * Labels the pieces of land in a mask, each piece's cells listed by label:
 * 8-connected by default, or 4-connected through `steps`.
 */
function components(
  mask: Uint8Array,
  width: number,
  height: number,
  steps: readonly (readonly [number, number])[] = neighbourSteps
): { cells: number[][]; label: Int32Array } {
  const label = new Int32Array(mask.length).fill(-1);
  const cells: number[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1 || label[start] !== -1) {
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
      for (const [dx, dy] of steps) {
        const c = column + dx;
        const r = row + dy;
        if (c < 0 || r < 0 || c >= width || r >= height) {
          continue;
        }
        const next = r * width + c;
        if (mask[next] === 1 && label[next] === -1) {
          label[next] = id;
          stack.push(next);
        }
      }
    }
    cells.push(members);
  }
  return { cells, label };
}

/** A mask with land and water swapped: 1 where `mask` is 0. */
function inverse(mask: Uint8Array): Uint8Array {
  const swapped = new Uint8Array(mask.length);
  for (let at = 0; at < mask.length; at += 1) {
    swapped[at] = mask[at] ? 0 : 1;
  }
  return swapped;
}

/**
 * Sets every enclosed pocket of water (cells where `isWater`) of at most
 * `most` cells to land via `fill`. The open water is flooded from the
 * raster's edge first, 4-connected; each pocket left is then flooded on
 * its own, 4-connected, and filled if it is small.
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
  const flood = () => {
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
  };
  for (let column = 0; column < width; column += 1) {
    visit(column);
    visit((height - 1) * width + column);
  }
  for (let row = 0; row < height; row += 1) {
    visit(row * width);
    visit(row * width + width - 1);
  }
  flood();
  // Water the open sea never reached lies in pockets: each flooded alone.
  for (let start = 0; start < isWater.length; start += 1) {
    if (!isWater[start] || open[start]) {
      continue;
    }
    head = 0;
    tail = 0;
    visit(start);
    flood();
    if (tail <= most) {
      for (let at = 0; at < tail; at += 1) {
        fill(queue[at] as number);
      }
    }
  }
}

/**
 * Each 4-connected piece of land: its cells, edge, depth and centre. An
 * islet touching larger land only corner to corner is a piece of its own,
 * as the traced coast keeps it, so it joins by a saddle like any other.
 */
function landPieces(
  land: Uint8Array,
  distance: Float32Array,
  frame: Frame
): { label: Int32Array; pieces: Piece[] } {
  const { width, height, resolution } = frame;
  const { cells, label } = components(land, width, height, edgeSteps);
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

/**
 * A sand saddle: the segment it runs along, from an islet to the land it
 * joins, and the half width of its waist in map units.
 */
interface Bar {
  from: readonly [number, number];
  to: readonly [number, number];
  waist: number;
}

/**
 * A submerged sand bank from a cay to the larger land it lies off: its
 * crest line in map positions, each end carried a little into the land.
 */
export interface SandBank {
  from: readonly [number, number];
  islandId: string;
  to: readonly [number, number];
}

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
  edges: readonly (readonly [number, number])[][]
): { from: [number, number]; gap: number; to: [number, number] } {
  const nearest = {
    from: [0, 0] as [number, number],
    gap: Number.POSITIVE_INFINITY,
    to: [0, 0] as [number, number],
  };
  const own = edges[pieces.indexOf(islet)] ?? [];
  const larger = pieces.flatMap((other, index) =>
    other.area > islet.area ? [edges[index] ?? []] : []
  );
  for (const pa of own) {
    for (const edge of larger) {
      for (const pb of edge) {
        const gap = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
        if (gap < nearest.gap) {
          nearest.gap = gap;
          nearest.from = [pa[0], pa[1]];
          nearest.to = [pb[0], pb[1]];
        }
      }
    }
  }
  return nearest;
}

/** A rectangle of raster cells, inclusive. */
interface CellWindow {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

/** The cells round an islet's edge, `margin` cells wider all round, clamped to the raster. */
function isletWindow(islet: Piece, frame: Frame, margin: number): CellWindow {
  let left = frame.width;
  let right = 0;
  let top = frame.height;
  let bottom = 0;
  for (const at of islet.border) {
    const column = at % frame.width;
    const row = (at - column) / frame.width;
    left = Math.min(left, column);
    right = Math.max(right, column);
    top = Math.min(top, row);
    bottom = Math.max(bottom, row);
  }
  return {
    bottom: Math.min(frame.height - 1, bottom + margin),
    left: Math.max(0, left - margin),
    right: Math.min(frame.width - 1, right + margin),
    top: Math.max(0, top - margin),
  };
}

/**
 * Map units from each cell of a window to one piece of land, `own`, and to
 * the rest of the island's land, by cell centres.
 */
function pieceDistances(
  land: Uint8Array,
  label: Int32Array,
  own: number,
  frame: Frame,
  window: CellWindow
): { other: Float32Array; self: Float32Array } {
  const width = window.right - window.left + 1;
  const height = window.bottom - window.top + 1;
  const mine = new Uint8Array(width * height);
  const theirs = new Uint8Array(width * height);
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const at = (r + window.top) * frame.width + c + window.left;
      if (land[at]) {
        const isOwn = label[at] === own;
        mine[r * width + c] = isOwn ? 1 : 0;
        theirs[r * width + c] = isOwn ? 0 : 1;
      }
    }
  }
  const self = shoreDistances(mine, width, height);
  const other = shoreDistances(theirs, width, height);
  for (let at = 0; at < self.length; at += 1) {
    self[at] = (self[at] ?? 0) * frame.resolution;
    other[at] = (other[at] ?? 0) * frame.resolution;
  }
  return { other, self };
}

/**
 * Where an islet's smallest disc is centred: its centre of area, set back
 * from the nearest other land, down the distance's slope, as far as keeps
 * the disc out of the channel between them, and never more than half the
 * radius, so the disc still holds the islet.
 */
function discCentre(
  islet: Piece,
  near: IsletNear,
  frame: Frame,
  radius: number
): [number, number] {
  const { other, width, window } = near;
  const height = window.bottom - window.top + 1;
  const column = Math.min(
    width - 1,
    Math.max(
      0,
      Math.floor((islet.x - frame.left) / frame.resolution) - window.left
    )
  );
  const row = Math.min(
    height - 1,
    Math.max(
      0,
      Math.floor((islet.y - frame.top) / frame.resolution) - window.top
    )
  );
  const at = (c: number, r: number) =>
    other[
      Math.min(height - 1, Math.max(0, r)) * width +
        Math.min(width - 1, Math.max(0, c))
    ] ?? 0;
  const dx = at(column + 1, row) - at(column - 1, row);
  const dy = at(column, row + 1) - at(column, row - 1);
  const slope = Math.hypot(dx, dy);
  // The channel's near shore lies about halfway to the other land, less half its width.
  const room = (at(column, row) - near.open) / 2;
  const back = Math.min(radius / 2, Math.max(0, radius - room));
  if (slope === 0 || back === 0) {
    return [islet.x, islet.y];
  }
  return [islet.x + (back * dx) / slope, islet.y + (back * dy) / slope];
}

/** How an island's islets meet the larger land they lie off. */
interface IsletShaping {
  /** Sand banks from each cay to the land it lies off, in map positions. */
  banks: SandBank[];
  /** Sand saddles from each islet that joins its land. */
  bars: Bar[];
  /**
   * Map units each cell lies inside the channel kept open beside a cay,
   * positive within it; absent where no cay keeps one.
   */
  channel: Float32Array | undefined;
  /** The centre of each islet's smallest disc, a map position. */
  discs: [number, number][];
  /** Cells nearer an islet than any other land: there the coast moves out at most `islets.outward`. */
  nearIslet: Uint8Array | undefined;
}

/**
 * How each islet meets the nearest larger piece of its island. Across a
 * gap of at most `islets.join` map units it joins it by a broad sand
 * saddle, whose waist is `saddle.share` of the islet's radius. Across a
 * wider gap it stays a cay: a channel of at least `channel.share` of the
 * gap to the nearest other land is kept open, so the coast's movement
 * never draws the two into a thin neck, and within `islets.reach` a
 * submerged sand bank runs between them. Every islet is grown to a disc of
 * at least `islets.radius`, set back from the nearest other land so the
 * channel leaves it round, and round it the coast moves out at most
 * `islets.outward`, so a cay never trails a tail.
 */
function isletShaping(
  island: TerrainIsland,
  land: Uint8Array,
  pieces: { label: Int32Array; pieces: readonly Piece[] },
  frame: Frame,
  settings: CoastSettings
): IsletShaping {
  const { resolution } = frame;
  const { islets } = settings;
  const isletCells = islets.area / resolution ** 2;
  const margin = Math.ceil(
    (settings.sculpt.outward + islets.radius + islets.reach) / resolution
  );
  const shaping: IsletShaping = {
    banks: [],
    bars: [],
    channel: undefined,
    discs: [],
    nearIslet: undefined,
  };
  // Each piece's edge cells as map positions, for the gaps between them.
  const edges = pieces.pieces.map((piece) =>
    piece.border.map((at) => cellCentre(frame, at))
  );
  for (const [index, islet] of pieces.pieces.entries()) {
    if (islet.area > isletCells) {
      continue;
    }
    const gap = nearestGap(islet, pieces.pieces, edges);
    if (!Number.isFinite(gap.gap) || gap.gap === 0) {
      shaping.discs.push([islet.x, islet.y]);
      continue;
    }
    const window = isletWindow(islet, frame, margin);
    const near = {
      ...pieceDistances(land, pieces.label, index, frame, window),
      open: 0,
      width: window.right - window.left + 1,
      window,
    };
    near.open = Math.max(
      islets.channel.least,
      islets.channel.share * markNearIslet(shaping, near, frame)
    );
    shaping.discs.push(discCentre(islet, near, frame, islets.radius));
    meetLand(shaping, { gap, island, islet, near }, frame, settings);
  }
  return shaping;
}

/** An islet's distances over its window, and the channel kept open beside it. */
interface IsletNear {
  open: number;
  other: Float32Array;
  self: Float32Array;
  width: number;
  window: CellWindow;
}

/** A window cell's index on the whole raster. */
function frameCell(near: IsletNear, frame: Frame, at: number): number {
  return (
    (Math.floor(at / near.width) + near.window.top) * frame.width +
    (at % near.width) +
    near.window.left
  );
}

/**
 * Marks the cells nearer an islet than any other land, and returns the
 * map units of water between the islet and the nearest other land.
 */
function markNearIslet(
  shaping: IsletShaping,
  near: IsletNear,
  frame: Frame
): number {
  const nearIslet =
    shaping.nearIslet ?? new Uint8Array(frame.width * frame.height);
  shaping.nearIslet = nearIslet;
  let water = Number.POSITIVE_INFINITY;
  for (let at = 0; at < near.self.length; at += 1) {
    if ((near.self[at] ?? 0) < (near.other[at] ?? 0)) {
      nearIslet[frameCell(near, frame, at)] = 1;
    }
    if (near.self[at] === 0) {
      water = Math.min(water, (near.other[at] ?? 0) - frame.resolution);
    }
  }
  return water;
}

/**
 * How one islet meets the nearest larger piece: a broad saddle across a
 * gap of at most `islets.join`, or else a channel kept open and, within
 * `islets.reach`, a sand bank between them.
 */
function meetLand(
  shaping: IsletShaping,
  meeting: {
    gap: ReturnType<typeof nearestGap>;
    island: TerrainIsland;
    islet: Piece;
    near: IsletNear;
  },
  frame: Frame,
  settings: CoastSettings
): void {
  const { resolution } = frame;
  const { islets } = settings;
  const { from, gap, to } = meeting.gap;
  const { near } = meeting;
  // The water between the two edges: the centres' gap less a cell.
  const water = gap - resolution;
  const ux = (to[0] - from[0]) / gap;
  const uy = (to[1] - from[1]) / gap;
  const into = 2 * resolution;
  const ends = {
    from: [from[0] - ux * into, from[1] - uy * into] as const,
    to: [to[0] + ux * into, to[1] + uy * into] as const,
  };
  if (water <= islets.join) {
    const radius = Math.max(
      islets.radius,
      Math.sqrt((meeting.islet.area * resolution ** 2) / Math.PI)
    );
    shaping.bars.push({
      ...ends,
      waist: Math.max(islets.saddle.width / 2, islets.saddle.share * radius),
    });
    return;
  }
  const channel =
    shaping.channel ??
    new Float32Array(frame.width * frame.height).fill(Number.NEGATIVE_INFINITY);
  shaping.channel = channel;
  for (let at = 0; at < near.self.length; at += 1) {
    const cell = frameCell(near, frame, at);
    const inside =
      (near.open - Math.abs((near.self[at] ?? 0) - (near.other[at] ?? 0))) / 2;
    channel[cell] = Math.max(channel[cell] ?? inside, inside);
  }
  if (water <= islets.reach) {
    shaping.banks.push({ ...ends, islandId: meeting.island.id });
  }
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
    inverse(land),
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
  /** Surveyed coast distance, its pools filled. */
  distance: Float32Array;
  files: Float32Array | undefined;
  islets: IsletShaping;
  label: Int32Array;
  noise: (x: number, y: number) => number;
  pieces: readonly Piece[];
  settings: CoastSettings;
  toOthers: Float32Array | undefined;
}

/**
 * The surveyed distance moved by the coast's noise: out by up to `outward`,
 * or `islets.outward` round an islet, and in by up to `inward`, or less on
 * a small piece.
 */
function sculpted(shaping: CoastShaping, at: number, x: number, y: number) {
  const { islets, sculpt } = shaping.settings;
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
  const outward = shaping.islets.nearIslet?.[at]
    ? Math.min(sculpt.outward, islets.outward)
    : sculpt.outward;
  return surveyed - (n > 0 ? n * outward : n * inward);
}

/**
 * A field joined with every cay's smallest disc and every sand saddle,
 * waisted between its ends and blended into the land over `saddle.flare`
 * map units, so its flanks curve in.
 */
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
  for (const [cx, cy] of shaping.islets.discs) {
    // A disc only lowers the field nearer its centre than `radius + joined`.
    const reach = islets.radius + joined;
    const dx = x - cx;
    const dy = y - cy;
    if (reach > 0 && dx * dx + dy * dy < reach * reach) {
      joined = Math.min(joined, Math.hypot(dx, dy) - islets.radius);
    }
  }
  for (const bar of shaping.islets.bars) {
    const { along, distance } = segmentDistance(x, y, bar.from, bar.to);
    const half = bar.waist * (1 + 0.5 * (2 * along - 1) ** 2);
    joined = smoothMin(joined, distance - half, islets.saddle.flare);
  }
  return joined;
}

/**
 * One cell of the coast field: sculpted, joined with its islets, a cay's
 * channel kept open, its files' land kept, and held clear of other islands.
 */
function shapedAt(shaping: CoastShaping, at: number, x: number, y: number) {
  const surveyed = shaping.distance[at] ?? 0;
  let value = withIslets(shaping, sculpted(shaping, at, x, y), x, y);
  const channel = shaping.islets.channel?.[at];
  if (channel !== undefined && channel > Number.NEGATIVE_INFINITY) {
    // A smooth maximum, so the channel rounds the shores it trims.
    value = -smoothMin(-value, -channel, shaping.settings.islets.channel.blend);
  }
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

/**
 * The cleaned and sculpted coast field of one island, map units, negative
 * on land, and the sand banks off its cays.
 */
function coastField(
  island: CoastIsland,
  others: readonly TerrainIsland[],
  settings: CoastSettings
): { banks: SandBank[]; field: Float32Array; frame: Frame } {
  const frame = islandFrame(island, settings);
  const { height, resolution, width } = frame;
  const land = cleanedLand(island, frame, settings);
  const distance = maskDistance(land, width, height, resolution);
  const { label, pieces } = landPieces(land, distance, frame);
  const islets = isletShaping(island, land, { label, pieces }, frame, settings);
  const shaping: CoastShaping = {
    distance,
    files: fileField(island, frame, settings.fileClearance),
    islets,
    label,
    noise: coastNoise(island, settings),
    pieces,
    settings,
    toOthers: othersDistance(others, frame),
  };
  const field = new Float32Array(width * height);
  const water = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const y = frame.top + (row + 0.5) * resolution;
    for (let column = 0; column < width; column += 1) {
      const at = row * width + column;
      const value = shapedAt(
        shaping,
        at,
        frame.left + (column + 0.5) * resolution,
        y
      );
      field[at] = value;
      water[at] = value >= 0 ? 1 : 0;
    }
  }
  fillPockets(
    water,
    width,
    height,
    settings.holeArea / resolution ** 2,
    (at) => {
      field[at] = -resolution / 2;
    }
  );
  return { banks: islets.banks, field, frame };
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
  const values: number[] = new Array(field.length);
  for (let at = 0; at < field.length; at += 1) {
    values[at] = -(field[at] ?? 0);
  }
  const [contour] = contours()
    .size([frame.width, frame.height])
    .thresholds([0])(values);
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

/** The preview's coasts and the sand banks off their cays. */
export interface PreviewShores {
  banks: readonly SandBank[];
  islands: readonly TerrainIsland[];
}

/** Preview shores kept by content: the most recent few. */
const shoresCacheEntries = 4;
const shoresCache = new Map<string, PreviewShores>();

/**
 * Content identity of a set of islands and settings, never a security
 * hash: two independent 32-bit hashes over the settings, and over every
 * island's id, place, radius, coast and files, each number by its bits and
 * each list by its length, so no two layouts read alike by accident.
 */
function shoresKey(
  islands: readonly CoastIsland[],
  settings: CoastSettings
): string {
  const scratch = new Float64Array(1);
  const words = new Uint32Array(scratch.buffer);
  let first = 2_166_136_261;
  let second = 0x9e_37_79_b9;
  // biome-ignore-start lint/suspicious/noBitwiseOperators: Deterministic 32-bit hashes identify cached coasts.
  const word = (value: number) => {
    first = Math.imul(first ^ value, 16_777_619) >>> 0;
    second = Math.imul((second ^ value) + 0x7f_4a_7c_15, 0x85_eb_ca_6b) >>> 0;
    second = (second ^ (second >>> 13)) >>> 0;
  };
  // biome-ignore-end lint/suspicious/noBitwiseOperators: Deterministic 32-bit hashes identify cached coasts.
  const number = (value: number) => {
    scratch[0] = value;
    word(words[0] ?? 0);
    word(words[1] ?? 0);
  };
  const text = (value: string) => {
    number(value.length);
    for (let index = 0; index < value.length; index += 1) {
      word(value.charCodeAt(index));
    }
  };
  text(JSON.stringify(settings));
  number(islands.length);
  for (const island of islands) {
    text(island.id);
    number(island.x);
    number(island.y);
    number(island.radius);
    number(island.coast.length);
    for (const polygon of island.coast) {
      number(polygon.length);
      for (const ring of polygon) {
        number(ring.length);
        for (const [x, y] of ring) {
          number(x);
          number(y);
        }
      }
    }
    const files = island.files ?? [];
    number(files.length);
    for (const file of files) {
      number(file.x);
      number(file.y);
    }
  }
  return `${first.toString(16)}:${second.toString(16)}`;
}

/**
 * Every island with its preview coast, and the sand banks off its cays:
 * each coast cleaned, sculpted and traced from its surveyed coast, every
 * file it lists kept on land. Ids, positions and radii are kept, files are
 * not carried on; islands are returned in the order given, and each is
 * seeded by its own id, so the result is deterministic. It is built once
 * per content and reused while the islands and settings are unchanged,
 * so the world terrain and the chart that reads its banks share one build.
 */
export function previewShores(
  islands: readonly CoastIsland[],
  settings: CoastSettings = defaultCoastSettings
): PreviewShores {
  const key = shoresKey(islands, settings);
  const cached = shoresCache.get(key);
  if (cached) {
    shoresCache.delete(key);
    shoresCache.set(key, cached);
    return cached;
  }
  const banks: SandBank[] = [];
  const traced = islands.map((island): TerrainIsland => {
    const others = islands.filter((other) => other.id !== island.id);
    const shaped = coastField(island, others, settings);
    banks.push(...shaped.banks);
    return {
      coast: traceCoast(shaped.field, shaped.frame, island),
      id: island.id,
      radius: island.radius,
      x: island.x,
      y: island.y,
    };
  });
  const shores: PreviewShores = { banks, islands: traced };
  shoresCache.set(key, shores);
  while (shoresCache.size > shoresCacheEntries) {
    const [oldest] = shoresCache.keys();
    if (oldest === undefined) {
      break;
    }
    shoresCache.delete(oldest);
  }
  return shores;
}

/** Every island with its preview coast, as `previewShores` builds them. */
export function previewCoasts(
  islands: readonly CoastIsland[],
  settings: CoastSettings = defaultCoastSettings
): readonly TerrainIsland[] {
  return previewShores(islands, settings).islands;
}

/**
 * The sand banks as seabed features on a grid: each raises the floor
 * toward a crest `bank.depth` nominal metres under the water along its
 * line, `bank.width` map units across at its waist and half as wide again
 * where it meets either shore, falling smoothly to the floor at its edges.
 * `floor` is the seabed the banks are raised from; where it already stands
 * above the crest a bank adds nothing.
 */
export function bankContributions(
  banks: readonly SandBank[],
  grid: GeologyGrid,
  floor: ArrayLike<number>,
  bank: CoastSettings["islets"]["bank"]
): SeabedContribution[] {
  const crest = elevationAtDepth(bank.depth);
  const broadest = 0.75 * bank.width;
  return banks.flatMap((each, index) => {
    const column = Math.max(
      0,
      Math.floor(
        (Math.min(each.from[0], each.to[0]) - broadest - grid.left) / grid.cell
      )
    );
    const row = Math.max(
      0,
      Math.floor(
        (Math.min(each.from[1], each.to[1]) - broadest - grid.top) / grid.cell
      )
    );
    const right = Math.min(
      grid.width - 1,
      Math.ceil(
        (Math.max(each.from[0], each.to[0]) + broadest - grid.left) / grid.cell
      )
    );
    const bottom = Math.min(
      grid.height - 1,
      Math.ceil(
        (Math.max(each.from[1], each.to[1]) + broadest - grid.top) / grid.cell
      )
    );
    if (right < column || bottom < row) {
      return [];
    }
    const width = right - column + 1;
    const height = bottom - row + 1;
    const values = new Float32Array(width * height);
    for (let r = 0; r < height; r += 1) {
      for (let c = 0; c < width; c += 1) {
        const at = (row + r) * grid.width + column + c;
        const { along, distance } = segmentDistance(
          grid.left + (column + c + 0.5) * grid.cell,
          grid.top + (row + r + 0.5) * grid.cell,
          each.from,
          each.to
        );
        const half = (bank.width / 2) * (1 + 0.5 * (2 * along - 1) ** 2);
        const rise = crest - (floor[at] ?? crest);
        if (distance < half && rise > 0) {
          values[r * width + c] = rise * smoothstep(0, 1, 1 - distance / half);
        }
      }
    }
    return [
      {
        column,
        height,
        id: `coast-bank:${each.islandId}:${index}`,
        row,
        values,
        width,
      },
    ];
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
      inverse(mask),
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
  const { cells } = components(cropped, width, height);
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
