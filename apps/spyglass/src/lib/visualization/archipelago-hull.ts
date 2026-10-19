import { contours } from "d3-contour";
import { shoreDistances } from "./distance-field";
import { type GeologyGrid, sampleGrid } from "./geology";
import { fillPolygon } from "./scanline-fill";
import type { TerrainIsland } from "./terrain";

type Point = [number, number];

/**
 * The archipelago's outer hull and the emanation that spreads from it. Each
 * workspace frame gets one smooth, simplified closed outline round all its
 * islands, far smoother than its platform: the frame's coast distance is
 * blurred, and the outline is the blurred field's level set that keeps
 * every coast at least `padding` away. The emanation is the signed distance
 * from the outlines over the whole sea, with a ring coordinate that is an
 * integer on each offset curve of the outline and a gradient from the
 * outline out to the sea's edge.
 */
export interface HullSettings {
  /** Map units across one cell of the grid each outline is traced on. */
  cell: number;
  /** Map units every coast keeps from its frame's outline, at least. */
  padding: number;
  /** Corner-cutting passes over the simplified outline. */
  passes: number;
  /** Cells across the emanation field's longer side. */
  resolution: number;
  /**
   * The emanation's rings: the first lies on the outline, the next `first`
   * map units out, and each following gap is `growth` map units wider than
   * the one before. `softness` is the share of each gap over which the
   * terraced gradient steps up to the next ring. Far rings are rounded:
   * from the outline out over `rounding.reach` map units the distance they
   * follow blends into itself blurred by `rounding.radius`.
   */
  rings: {
    first: number;
    growth: number;
    rounding: { radius: number; reach: number };
    softness: number;
  };
  /**
   * Map units of blur over the coast distance before the outline is
   * traced: bays narrower than about twice this fill, and lobes round to
   * about this radius.
   */
  smoothness: number;
  /** Map units the simplified outline may stray from the traced one. */
  tolerance: number;
}

/**
 * With the current platform the escarpment's foot lies some 170 map units
 * past the coasts, so the outline sits on the open abyss just beyond it and
 * every ring lies in open water.
 */
export const defaultHullSettings: HullSettings = {
  cell: 8,
  padding: 170,
  passes: 3,
  resolution: 512,
  rings: {
    first: 60,
    growth: 20,
    rounding: { radius: 120, reach: 600 },
    softness: 0.35,
  },
  smoothness: 150,
  tolerance: 6,
};

/** An island of one frame: the frame's id is its group. */
export interface HullIsland
  extends Pick<TerrainIsland, "coast" | "id" | "radius" | "x" | "y"> {
  /** The workspace frame the island belongs to; islands of one group share an outline. */
  group: string;
}

export interface HullInput {
  islands: readonly HullIsland[];
}

/** One frame's outer hull. */
export interface ArchipelagoOutline {
  /** The least map units from any of the frame's coast vertices to the outline. */
  clearance: number;
  group: string;
  /** The frame's islands, by id. */
  islands: readonly string[];
  /** The closed outline in map units, its last point not repeated, wound with a positive shoelace area. */
  points: readonly Point[];
}

/** A grid crop in map units: `left` and `top` are the west and north edges of its first cell. */
interface Crop extends GeologyGrid {
  /** Map units to the nearest coast by cell, 0 on land. */
  distance: Float32Array;
  land: Uint8Array;
}

/** Iterations of the binary search for the level that joins a frame's islands. */
const joinSearchSteps = 24;
/** Attempts to raise the level until the smoothed outline keeps its padding. */
const clearanceAttempts = 8;

/** Each island's outer coast rings in map units; a disc of its radius where it has no coast. */
function coastRings(island: HullIsland): Point[][] {
  const rings = island.coast
    .map((polygon) => polygon[0] ?? [])
    .filter((ring) => ring.length >= 3)
    .map((ring) =>
      ring.map(([x = 0, y = 0]): Point => [island.x + x, island.y + y])
    );
  if (rings.length) {
    return rings;
  }
  const sides = 16;
  return [
    Array.from({ length: sides }, (_, i): Point => {
      const angle = (i / sides) * Math.PI * 2;
      return [
        island.x + island.radius * Math.cos(angle),
        island.y + island.radius * Math.sin(angle),
      ];
    }),
  ];
}

/** The coasts filled on a grid `margin` map units round them, and each cell's distance to the nearest. */
function coastCrop(rings: readonly Point[][], cell: number, margin: number) {
  let west = Number.POSITIVE_INFINITY;
  let north = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let south = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      west = Math.min(west, x);
      north = Math.min(north, y);
      east = Math.max(east, x);
      south = Math.max(south, y);
    }
  }
  const left = west - margin;
  const top = north - margin;
  const width = Math.max(2, Math.ceil((east + margin - left) / cell));
  const height = Math.max(2, Math.ceil((south + margin - top) / cell));
  const land = new Uint8Array(width * height);
  for (const ring of rings) {
    fillPolygon(land, width, height, [
      ring.map(([x, y]): Point => [(x - left) / cell, (y - top) / cell]),
    ]);
  }
  const cells = shoreDistances(land, width, height);
  const distance = Float32Array.from(cells, (value, at) =>
    land[at] ? 0 : Math.max(0, value - 0.5) * cell
  );
  return { cell, distance, height, land, left, top, width } satisfies Crop;
}

/** The running mean of `line` over `radius` entries either side, clipped at its ends, into `out`. */
function runningMean(
  line: Float64Array,
  radius: number,
  out: Float64Array
): void {
  let sum = 0;
  let taken = 0;
  for (let i = 0; i < Math.min(radius, line.length); i += 1) {
    sum += line[i] ?? 0;
    taken += 1;
  }
  for (let i = 0; i < line.length; i += 1) {
    if (i + radius < line.length) {
      sum += line[i + radius] ?? 0;
      taken += 1;
    }
    if (i - radius - 1 >= 0) {
      sum -= line[i - radius - 1] ?? 0;
      taken -= 1;
    }
    out[i] = sum / taken;
  }
}

/** One box mean of a row-major field over `radius` cells about each cell, in place. */
function boxPass(
  values: Float64Array,
  width: number,
  height: number,
  radius: number
): void {
  const row = new Float64Array(width);
  const rowOut = new Float64Array(width);
  for (let r = 0; r < height; r += 1) {
    row.set(values.subarray(r * width, (r + 1) * width));
    runningMean(row, radius, rowOut);
    values.set(rowOut, r * width);
  }
  const column = new Float64Array(height);
  const columnOut = new Float64Array(height);
  for (let c = 0; c < width; c += 1) {
    for (let r = 0; r < height; r += 1) {
      column[r] = values[r * width + c] ?? 0;
    }
    runningMean(column, radius, columnOut);
    for (let r = 0; r < height; r += 1) {
      values[r * width + c] = columnOut[r] ?? 0;
    }
  }
}

/**
 * The coast distance blurred by three box means of `radius` cells, close to
 * a Gaussian of that many cells' deviation. The crop's border is held far
 * above any level, so every level set closes inside the crop.
 */
function blurredDistance(crop: Crop, radius: number): Float64Array {
  const values = Float64Array.from(crop.distance);
  if (radius > 0) {
    for (let pass = 0; pass < 3; pass += 1) {
      boxPass(values, crop.width, crop.height, radius);
    }
  }
  const far = Number.MAX_SAFE_INTEGER;
  for (let c = 0; c < crop.width; c += 1) {
    values[c] = far;
    values[(crop.height - 1) * crop.width + c] = far;
  }
  for (let r = 0; r < crop.height; r += 1) {
    values[r * crop.width] = far;
    values[r * crop.width + crop.width - 1] = far;
  }
  return values;
}

/** Whether every land cell lies in one 4-connected region of cells at or under `level`. */
function joined(crop: Crop, field: Float64Array, level: number): boolean {
  const start = crop.land.indexOf(1);
  if (start < 0) {
    return true;
  }
  const seen = new Uint8Array(field.length);
  const stack = new Int32Array(field.length);
  stack[0] = start;
  let size = 1;
  seen[start] = 1;
  while (size > 0) {
    size -= 1;
    const at = stack[size] ?? 0;
    const column = at % crop.width;
    const neighbours = [
      column > 0 ? at - 1 : -1,
      column < crop.width - 1 ? at + 1 : -1,
      at - crop.width,
      at + crop.width,
    ];
    for (const next of neighbours) {
      if (
        next >= 0 &&
        next < field.length &&
        !seen[next] &&
        (field[next] ?? Number.POSITIVE_INFINITY) <= level
      ) {
        seen[next] = 1;
        stack[size] = next;
        size += 1;
      }
    }
  }
  return crop.land.every((cell, at) => cell === 0 || seen[at] === 1);
}

/**
 * The lowest level of the blurred field that holds every cell within
 * `padding` of a coast and joins every island into one region.
 */
function enclosingLevel(crop: Crop, field: Float64Array, padding: number) {
  let level = 0;
  for (const [at, distance] of crop.distance.entries()) {
    if (distance <= padding) {
      level = Math.max(level, field[at] ?? 0);
    }
  }
  if (joined(crop, field, level)) {
    return level;
  }
  let low = level;
  let high = level * 2 + crop.cell;
  while (!joined(crop, field, high)) {
    high *= 2;
  }
  for (let step = 0; step < joinSearchSteps; step += 1) {
    const middle = (low + high) / 2;
    if (joined(crop, field, middle)) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return high;
}

/** Twice a ring's shoelace area, positive when it winds clockwise on a y-down chart. */
function signedArea(ring: readonly Point[]): number {
  let area = 0;
  for (const [i, [x, y]] of ring.entries()) {
    const [nx, ny] = ring[(i + 1) % ring.length] ?? [x, y];
    area += x * ny - nx * y;
  }
  return area;
}

/** The outer ring of the largest region where the blurred field is at or under `level`, in map units. */
function levelRing(crop: Crop, field: Float64Array, level: number): Point[] {
  const negated = Array.from(field, (value) => -value);
  const [contour] = contours()
    .size([crop.width, crop.height])
    .thresholds([-level])(negated);
  let best: Point[] = [];
  let bestArea = 0;
  for (const polygon of contour?.coordinates ?? []) {
    const outer = (polygon[0] ?? []).map(
      ([x = 0, y = 0]): Point => [
        crop.left + x * crop.cell,
        crop.top + y * crop.cell,
      ]
    );
    outer.pop();
    const area = Math.abs(signedArea(outer));
    if (area > bestArea) {
      best = outer;
      bestArea = area;
    }
  }
  return best;
}

/** Squared distance from `p` to the segment from `a` to `b`. */
function segmentSquared(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t =
    length > 0
      ? Math.min(
          1,
          Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)
        )
      : 0;
  const ex = p[0] - a[0] - t * dx;
  const ey = p[1] - a[1] - t * dy;
  return ex * ex + ey * ey;
}

/** Distance from `p` to the segment from `a` to `b`. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  return Math.sqrt(segmentSquared(p, a, b));
}

/** Douglas–Peucker over an open chain, keeping both ends. */
function simplifyChain(chain: readonly Point[], tolerance: number): Point[] {
  const [first] = chain;
  const last = chain.at(-1);
  if (!(first && last) || chain.length < 3) {
    return [...chain];
  }
  let farthest = 0;
  let index = 0;
  for (let i = 1; i < chain.length - 1; i += 1) {
    const distance = segmentDistance(chain[i] ?? first, first, last);
    if (distance > farthest) {
      farthest = distance;
      index = i;
    }
  }
  if (farthest <= tolerance) {
    return [first, last];
  }
  const head = simplifyChain(chain.slice(0, index + 1), tolerance);
  const tail = simplifyChain(chain.slice(index), tolerance);
  return [...head.slice(0, -1), ...tail];
}

/** Douglas–Peucker over a closed ring, split at its first point and the point farthest from it. */
function simplifyRing(ring: readonly Point[], tolerance: number): Point[] {
  const [start] = ring;
  if (!start || ring.length < 4) {
    return [...ring];
  }
  let index = 0;
  let farthest = 0;
  for (const [i, p] of ring.entries()) {
    const distance = Math.hypot(p[0] - start[0], p[1] - start[1]);
    if (distance > farthest) {
      farthest = distance;
      index = i;
    }
  }
  const out = simplifyChain(ring.slice(0, index + 1), tolerance);
  const back = simplifyChain([...ring.slice(index), start], tolerance);
  return [...out.slice(0, -1), ...back.slice(0, -1)];
}

/** Chaikin's corner cutting over a closed ring, `passes` times. */
function chaikinRing(ring: readonly Point[], passes: number): Point[] {
  let current = [...ring];
  for (let pass = 0; pass < passes && current.length >= 3; pass += 1) {
    current = current.flatMap((p, i): Point[] => {
      const q = current[(i + 1) % current.length] ?? p;
      return [
        [0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]],
        [0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]],
      ];
    });
  }
  return current;
}

/** Whether `p` lies inside a closed ring, by the even-odd rule. */
function insideRing(ring: readonly Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i] ?? p;
    const b = ring[j] ?? a;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Map units from `p` to the nearest edge of a closed ring. */
function distanceToRing(ring: readonly Point[], p: Point): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i] ?? p;
    nearest = Math.min(nearest, segmentSquared(p, ring[j] ?? a, a));
  }
  return Math.sqrt(nearest);
}

/** The least clearance of any coast vertex inside the ring; negative where one lies outside it. */
function clearanceOf(ring: readonly Point[], rings: readonly Point[][]) {
  let least = Number.POSITIVE_INFINITY;
  for (const coast of rings) {
    for (const p of coast) {
      const distance = distanceToRing(ring, p);
      least = Math.min(least, insideRing(ring, p) ? distance : -distance);
    }
  }
  return least;
}

/** The traced level set simplified, corner-cut and lightly simplified again, wound with a positive area. */
function smoothRing(raw: readonly Point[], settings: HullSettings): Point[] {
  const simplified = simplifyRing(raw, settings.tolerance);
  const smooth = simplifyRing(
    chaikinRing(simplified, settings.passes),
    settings.tolerance / 16
  );
  return signedArea(smooth) < 0 ? smooth.reverse() : smooth;
}

/** One frame's outline round its islands' coasts. */
function frameOutline(
  rings: readonly Point[][],
  settings: HullSettings
): { clearance: number; points: Point[] } {
  const cell = Math.max(settings.cell, 1e-3);
  const radius = Math.max(0, Math.round(settings.smoothness / cell));
  let margin = settings.padding + 3 * settings.smoothness + 2 * cell;
  let crop = coastCrop(rings, cell, margin);
  let field = blurredDistance(crop, radius);
  let level = enclosingLevel(crop, field, settings.padding);
  // A frame whose islands lie far apart joins on a high level: widen the crop to hold it.
  if (level + 3 * settings.smoothness + 2 * cell > margin) {
    margin = level + 3 * settings.smoothness + 4 * cell;
    crop = coastCrop(rings, cell, margin);
    field = blurredDistance(crop, radius);
    level = enclosingLevel(crop, field, settings.padding);
  }
  level += settings.tolerance;
  let points: Point[] = [];
  let clearance = Number.NEGATIVE_INFINITY;
  for (let attempt = 0; attempt < clearanceAttempts; attempt += 1) {
    points = smoothRing(levelRing(crop, field, level), settings);
    clearance = clearanceOf(points, rings);
    if (clearance >= settings.padding) {
      break;
    }
    level += settings.padding - clearance + cell;
  }
  return { clearance, points };
}

/** Islands grouped by frame, groups sorted and islands by id within each. */
function groupIslands(islands: readonly HullIsland[]) {
  const groups = new Map<string, HullIsland[]>();
  for (const island of [...islands].sort((a, b) => a.id.localeCompare(b.id))) {
    const members = groups.get(island.group) ?? [];
    members.push(island);
    groups.set(island.group, members);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * One smooth, simplified closed outline per workspace frame, enclosing all
 * of the frame's islands with at least `padding` to spare. The frame's coast
 * distance is blurred by `smoothness`, and the outline is the lowest level
 * of the blurred field that holds every cell within `padding` of a coast in
 * one region; it is simplified to `tolerance`, corner-cut and checked
 * against every coast vertex, and the level is raised until it keeps its
 * padding. The same islands give the same outlines in any order.
 */
export function archipelagoOutline(
  input: HullInput,
  settings: HullSettings = defaultHullSettings
): ArchipelagoOutline[] {
  return groupIslands(input.islands).flatMap(([group, members]) => {
    const rings = members.flatMap(coastRings);
    if (!rings.length) {
      return [];
    }
    const { clearance, points } = frameOutline(rings, settings);
    return points.length >= 3
      ? [{ clearance, group, islands: members.map(({ id }) => id), points }]
      : [];
  });
}

/** Map units from the outline out to ring `index`: the ring law. */
export function ringOffset(
  index: number,
  rings: HullSettings["rings"] = defaultHullSettings.rings
): number {
  return rings.first * index + (rings.growth * index * (index - 1)) / 2;
}

/**
 * The ring coordinate `distance` map units outside the outline: an integer
 * on every ring, as `ringOffset` places them, rising between them. Inside
 * the outline it falls on linearly at the first gap's rate, so it is
 * negative there and continuous across the outline.
 */
export function ringCoordinate(
  distance: number,
  rings: HullSettings["rings"] = defaultHullSettings.rings
): number {
  const first = Math.max(rings.first, 1e-6);
  if (distance <= 0 || rings.growth <= 0) {
    return distance / first;
  }
  const b = first - rings.growth / 2;
  return (-b + Math.sqrt(b * b + 2 * rings.growth * distance)) / rings.growth;
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** The emanation over the sea: four values a cell, row-major over its grid. */
export interface EmanationField extends GeologyGrid {
  /** Signed map units from the nearest outline, negative inside one: exact, before rounding. */
  distance: Float32Array;
  /** 0 on and inside the outlines, rising to 1 at the sea's edge. */
  gradient: Float32Array;
  /** `ringCoordinate` of the distance: an integer on every ring. */
  ring: Float32Array;
  /** The gradient held on each ring's value and stepped up to the next one's just before it. */
  terraced: Float32Array;
}

/** One closed ring as flat segment arrays, with each segment's bounding box. */
function segments(points: readonly Point[]) {
  const count = points.length;
  const ax = new Float64Array(count);
  const ay = new Float64Array(count);
  const bx = new Float64Array(count);
  const by = new Float64Array(count);
  for (const [i, a] of points.entries()) {
    const b = points[(i + 1) % count] ?? a;
    ax[i] = a[0];
    ay[i] = a[1];
    bx[i] = b[0];
    by[i] = b[1];
  }
  return { ax, ay, bx, by, count };
}

type Segments = ReturnType<typeof segments>;

/** Squared distance from (x, y) to segment `i`. */
function squaredTo(s: Segments, i: number, x: number, y: number): number {
  const ax = s.ax[i] ?? 0;
  const ay = s.ay[i] ?? 0;
  const dx = (s.bx[i] ?? 0) - ax;
  const dy = (s.by[i] ?? 0) - ay;
  const length = dx * dx + dy * dy;
  const t =
    length > 0
      ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length))
      : 0;
  const ex = x - ax - t * dx;
  const ey = y - ay - t * dy;
  return ex * ex + ey * ey;
}

/** Squared distance from a rectangle to segment `i`'s bounding box. */
function squaredBoxGap(
  s: Segments,
  i: number,
  box: { east: number; north: number; south: number; west: number }
): number {
  const ax = s.ax[i] ?? 0;
  const ay = s.ay[i] ?? 0;
  const bx = s.bx[i] ?? 0;
  const by = s.by[i] ?? 0;
  const gx = Math.max(
    0,
    Math.min(ax, bx) - box.east,
    box.west - Math.max(ax, bx)
  );
  const gy = Math.max(
    0,
    Math.min(ay, by) - box.south,
    box.north - Math.max(ay, by)
  );
  return gx * gx + gy * gy;
}

/** Cells along a tile's side when the exact distance prunes segments. */
const tileSize = 16;

/** The segments that may be nearest to some cell centre of a tile. */
function tileCandidates(
  s: Segments,
  box: { east: number; north: number; south: number; west: number }
): number[] {
  const cx = (box.west + box.east) / 2;
  const cy = (box.north + box.south) / 2;
  const half = Math.hypot(box.east - box.west, box.south - box.north) / 2;
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < s.count; i += 1) {
    nearest = Math.min(nearest, squaredTo(s, i, cx, cy));
  }
  const bound = (Math.sqrt(nearest) + half) ** 2;
  const kept: number[] = [];
  for (let i = 0; i < s.count; i += 1) {
    if (squaredBoxGap(s, i, box) <= bound) {
      kept.push(i);
    }
  }
  return kept;
}

/** Coarse cells' size in fine cells, for the distance far from every outline. */
const coarseStride = 4;
/** Coarse cells from an outline within which the distance is measured exactly at every fine cell. */
const exactBand = 6;

/**
 * Map units from cell centres of a grid to the nearest edge of one closed
 * ring, exactly, into `out`: every cell, or only those `near` reads under
 * `band`. Segments are pruned by tile, so a cell compares only the
 * segments that may be nearest to it.
 */
function measure(
  s: Segments,
  grid: GeologyGrid,
  out: Float32Array,
  near?: { band: number; values: Float32Array }
): void {
  const centre = (index: number, origin: number) =>
    origin + (index + 0.5) * grid.cell;
  const wanted = (at: number) => !near || (near.values[at] ?? 0) < near.band;
  for (let row0 = 0; row0 < grid.height; row0 += tileSize) {
    const row1 = Math.min(grid.height, row0 + tileSize);
    for (let column0 = 0; column0 < grid.width; column0 += tileSize) {
      const column1 = Math.min(grid.width, column0 + tileSize);
      let kept: number[] | undefined;
      for (let row = row0; row < row1; row += 1) {
        const y = centre(row, grid.top);
        for (let column = column0; column < column1; column += 1) {
          const at = row * grid.width + column;
          if (!wanted(at)) {
            continue;
          }
          kept ??= tileCandidates(s, {
            east: centre(column1 - 1, grid.left),
            north: centre(row0, grid.top),
            south: centre(row1 - 1, grid.top),
            west: centre(column0, grid.left),
          });
          const x = centre(column, grid.left);
          let nearest = Number.POSITIVE_INFINITY;
          for (const i of kept) {
            nearest = Math.min(nearest, squaredTo(s, i, x, y));
          }
          out[at] = Math.sqrt(nearest);
        }
      }
    }
  }
}

/**
 * Map units from every cell centre of a grid to the nearest edge of one
 * closed ring. It is measured on a grid `coarseStride` times coarser that
 * reaches a coarse cell past the fine one on every side, to the ring
 * simplified within a quarter of a fine cell, and read bilinearly from it;
 * within `exactBand` coarse cells of the ring,
 * where the field bends most, it is measured exactly at every cell.
 */
function ringField(points: readonly Point[], grid: GeologyGrid): Float32Array {
  const s = segments(points);
  const cell = grid.cell * coarseStride;
  // Far from the ring a simpler ring, within a quarter of a fine cell, measures the same.
  const far = segments(simplifyRing(points, grid.cell / 4));
  const coarse: GeologyGrid = {
    cell,
    height: Math.ceil(grid.height / coarseStride) + 2,
    left: grid.left - cell,
    top: grid.top - cell,
    width: Math.ceil(grid.width / coarseStride) + 2,
  };
  const coarseValues = new Float32Array(coarse.width * coarse.height);
  measure(far, coarse, coarseValues);
  const out = new Float32Array(grid.width * grid.height);
  for (let row = 0; row < grid.height; row += 1) {
    const y = grid.top + (row + 0.5) * grid.cell;
    for (let column = 0; column < grid.width; column += 1) {
      out[row * grid.width + column] = sampleGrid(
        coarse,
        coarseValues,
        grid.left + (column + 0.5) * grid.cell,
        y
      );
    }
  }
  measure(s, grid, out, { band: exactBand * cell, values: out });
  return out;
}

/**
 * Signed map units from the nearest outline at every cell: the least of
 * each outline's own signed distance, negative inside it. Where two
 * frames' fields meet the least is continuous, so their rings join.
 */
function signedDistance(
  outlines: readonly Pick<ArchipelagoOutline, "points">[],
  grid: GeologyGrid
): Float32Array {
  const size = grid.width * grid.height;
  const signed = new Float32Array(size).fill(Number.POSITIVE_INFINITY);
  for (const { points } of outlines) {
    if (points.length < 3) {
      continue;
    }
    const inside = new Uint8Array(size);
    fillPolygon(inside, grid.width, grid.height, [
      points.map(
        ([x, y]): Point => [
          (x - grid.left) / grid.cell,
          (y - grid.top) / grid.cell,
        ]
      ),
    ]);
    const distance = ringField(points, grid);
    for (let at = 0; at < size; at += 1) {
      const own = inside[at] ? -(distance[at] ?? 0) : (distance[at] ?? 0);
      signed[at] = Math.min(signed[at] ?? own, own);
    }
  }
  return signed;
}

/**
 * The distance the rings follow: the signed distance itself near the
 * outlines, blending outward over `reach` map units into the same field
 * blurred by `radius`, so far rings round off the creases a concave
 * outline leaves in its offset curves.
 */
function roundedDistance(
  signed: Float32Array,
  grid: GeologyGrid,
  rounding: HullSettings["rings"]["rounding"]
): Float32Array {
  const radius = Math.round(rounding.radius / grid.cell);
  if (radius <= 0) {
    return signed;
  }
  const blurred = Float64Array.from(signed);
  for (let pass = 0; pass < 3; pass += 1) {
    boxPass(blurred, grid.width, grid.height, radius);
  }
  return Float32Array.from(signed, (distance, at) => {
    const weight = smoothstep(0, Math.max(rounding.reach, 1e-6), distance);
    return distance + ((blurred[at] ?? distance) - distance) * weight;
  });
}

/** The ring coordinate and both gradients `distance` map units outside the outlines and `edge` inside the sea's edge. */
function emanationAt(
  distance: number,
  edge: number,
  rings: HullSettings["rings"]
): { gradient: number; ring: number; terraced: number } {
  const ring = ringCoordinate(distance, rings);
  if (distance <= 0) {
    return { gradient: 0, ring, terraced: 0 };
  }
  const total = distance + Math.max(0, edge);
  const index = Math.floor(ring);
  const from = ringOffset(index, rings);
  const softness = Math.min(1, Math.max(1e-3, rings.softness));
  const step = smoothstep(1 - softness, 1, ring - index);
  const held = from + (ringOffset(index + 1, rings) - from) * step;
  return {
    gradient: distance / total,
    ring,
    terraced: Math.min(1, held / total),
  };
}

/** The field's grid over an extent about the chart's centre: `resolution` cells along its longer side. */
function emanationGrid(
  extent: { height: number; width: number },
  resolution: number = defaultHullSettings.resolution
): GeologyGrid {
  const cell =
    Math.max(extent.width, extent.height) / Math.max(1, Math.round(resolution));
  const width = Math.max(2, Math.round(extent.width / cell));
  const height = Math.max(2, Math.round(extent.height / cell));
  return {
    cell,
    height,
    left: (-width * cell) / 2,
    top: (-height * cell) / 2,
    width,
  };
}

/**
 * The emanation from the outlines over a sea `extent` map units about the
 * chart's centre, on a grid of `resolution` cells along its longer side:
 * the signed distance from the nearest outline, the ring coordinate of
 * `ringCoordinate`, and a gradient `d / (d + e)`, where `d` is the distance
 * outside the outlines and `e` the distance to the grid's edge less half a
 * cell, so it is 0 on the outline and 1 in the outermost cells. The rings
 * and gradients follow the distance as `rings.rounding` rounds it. The
 * terraced gradient holds each ring's value across its gap and steps to the
 * next over the last `softness` of it. With no outline every value is 0.
 */
export function emanationField(
  outlines: readonly Pick<ArchipelagoOutline, "points">[],
  extent: { height: number; width: number },
  settings: HullSettings = defaultHullSettings
): EmanationField {
  const grid = emanationGrid(extent, settings.resolution);
  const size = grid.width * grid.height;
  const field: EmanationField = {
    ...grid,
    distance: new Float32Array(size),
    gradient: new Float32Array(size),
    ring: new Float32Array(size),
    terraced: new Float32Array(size),
  };
  if (!outlines.some(({ points }) => points.length >= 3)) {
    return field;
  }
  // The rounding blur reads past the sea's edge, so measure a margin round it.
  const pad =
    3 * Math.max(0, Math.round(settings.rings.rounding.radius / grid.cell));
  const outer: GeologyGrid = {
    cell: grid.cell,
    height: grid.height + 2 * pad,
    left: grid.left - pad * grid.cell,
    top: grid.top - pad * grid.cell,
    width: grid.width + 2 * pad,
  };
  const signed = signedDistance(outlines, outer);
  const rounded = roundedDistance(signed, outer, settings.rings.rounding);
  for (let row = 0; row < grid.height; row += 1) {
    const toEdge = Math.min(row, grid.height - 1 - row);
    for (let column = 0; column < grid.width; column += 1) {
      const at = row * grid.width + column;
      const from = (row + pad) * outer.width + column + pad;
      const edge =
        Math.min(toEdge, column, grid.width - 1 - column) * grid.cell;
      const value = emanationAt(rounded[from] ?? 0, edge, settings.rings);
      field.distance[at] = signed[from] ?? 0;
      field.ring[at] = value.ring;
      field.gradient[at] = value.gradient;
      field.terraced[at] = value.terraced;
    }
  }
  return field;
}

/** One of the emanation's rings, or the piece of one the sea holds, as a polyline in map units. */
export interface HullRing {
  /**
   * Whether the polyline closes on itself. An open one is a piece of a
   * ring the sea's edge cuts: it runs from within a cell of the edge to
   * within a cell of it again.
   */
  closed: boolean;
  /** The ring's index: 0 on the outline, rising outward. */
  index: number;
  /** Map units from the outline out to the ring, `ringOffset` of its index. */
  offset: number;
  /** The ring's points in map units; a closed ring's last point is not repeated. */
  points: readonly Point[];
}

/** Whether a traced point lies on the grid's border, where the tracing closes regions the sea's edge cuts. */
function onBorder([x, y]: Point, grid: GeologyGrid): boolean {
  return x <= 0 || y <= 0 || x >= grid.width || y >= grid.height;
}

/**
 * One traced loop of a level set as the pieces of ring it holds, in map
 * units: the loop itself where it never meets the grid's border, or the
 * runs between the border's stretches where it does.
 */
function ringPieces(
  loop: readonly Point[],
  grid: GeologyGrid
): { closed: boolean; points: Point[] }[] {
  const traced = loop.slice(0, -1);
  if (signedArea(traced) < 0) {
    traced.reverse();
  }
  const toMap = ([x, y]: Point): Point => [
    grid.left + x * grid.cell,
    grid.top + y * grid.cell,
  ];
  const start = traced.findIndex((point) => onBorder(point, grid));
  if (start < 0) {
    return traced.length >= 3
      ? [{ closed: true, points: traced.map(toMap) }]
      : [];
  }
  const pieces: { closed: boolean; points: Point[] }[] = [];
  let run: Point[] = [];
  // From one border point round to it again, so no run is split at the seam.
  for (let step = 1; step <= traced.length; step += 1) {
    const point = traced[(start + step) % traced.length] ?? [0, 0];
    if (!onBorder(point, grid)) {
      run.push(toMap(point));
      continue;
    }
    if (run.length >= 2) {
      pieces.push({ closed: false, points: run });
    }
    run = [];
  }
  return pieces;
}

/**
 * The emanation's rings as polylines in map units, ring by ring outward
 * from the outline at index 0 to the last the sea holds: the level sets of
 * the field's ring coordinate at every integer, so each follows the line
 * the ring coordinate draws, rounded far out as `rings.rounding` rounds
 * it, rather than a bare offset of the outline. A ring may come in several
 * pieces: one round each frame until their fields meet, one round each
 * pocket of open sea between hulls, and open pieces where the sea's edge
 * cuts it. Closed rings are wound as the outlines are. With no outline
 * there are none.
 */
export function hullRings(
  field: EmanationField,
  rings: HullSettings["rings"] = defaultHullSettings.rings
): HullRing[] {
  let highest = Number.NEGATIVE_INFINITY;
  for (const value of field.ring) {
    highest = Math.max(highest, value);
  }
  if (!(highest > 0)) {
    return [];
  }
  // The tracing bounds regions at or over a level; negated, the region
  // inside each ring.
  const negated = Array.from(field.ring, (value) => -value);
  const tracer = contours().size([field.width, field.height]);
  const out: HullRing[] = [];
  for (let index = 0; index <= Math.floor(highest); index += 1) {
    const offset = ringOffset(index, rings);
    const traced = tracer.contour(negated, -index);
    for (const polygon of traced.coordinates) {
      for (const loop of polygon) {
        for (const piece of ringPieces(loop as Point[], field)) {
          out.push({ ...piece, index, offset });
        }
      }
    }
  }
  return out;
}
