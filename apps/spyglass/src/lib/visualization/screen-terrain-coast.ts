import type { TerrainIsland } from "./terrain";

/**
 * The preview's coasts as a shader reads them: every ring of every island
 * as straight segments, and a grid of bins, each listing the segments any
 * point inside it could find nearest. A pixel reads its bin, measures the
 * true distance to each listed segment and counts the segments its ray from
 * the bin's corner crosses, so the coast's signed distance is exact at any
 * zoom, with no raster's stair steps. `coastDistance` is the CPU twin of
 * the shader's query, for tests and reference renders.
 */
export interface CoastSegments {
  /** Each segment's island index, into the order the segments were built for. */
  island: Int32Array;
  /** Four floats a segment: its ends in map units, x and y each. */
  points: Float64Array;
}

/** Bins over the map, in map units, row 0 at the chart's top. */
export interface CoastBinGrid {
  /** Map units along a bin's side. */
  cell: number;
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface CoastBins extends CoastBinGrid {
  /** Three values a bin: where its list starts, how many segments it lists, and 1 if its corner lies on land. */
  bins: Uint32Array;
  /** Segment indices, each bin's run in turn. */
  list: Uint32Array;
}

/**
 * Where a bin's ray starts, off its north-west corner: a hair inside, so
 * the corner never lies exactly on a coast. The shader adds the same.
 */
export const binCorner = { x: 0.019_13, y: 0.014_71 } as const;

/** Every ring of every island's coast as segments in map units, islands in the order of `islandIds`. */
export function coastSegments(
  islands: readonly TerrainIsland[],
  islandIds: readonly string[]
): CoastSegments {
  const points: number[] = [];
  const owners: number[] = [];
  for (const island of islands) {
    const owner = islandIds.indexOf(island.id);
    for (const polygon of island.coast) {
      for (const ring of polygon) {
        for (let index = 0; index < ring.length; index += 1) {
          const [ax = 0, ay = 0] = ring[index] ?? [];
          const [bx = 0, by = 0] = ring[(index + 1) % ring.length] ?? [];
          if (ax !== bx || ay !== by) {
            points.push(
              island.x + ax,
              island.y + ay,
              island.x + bx,
              island.y + by
            );
            owners.push(owner);
          }
        }
      }
    }
  }
  return { island: Int32Array.from(owners), points: Float64Array.from(points) };
}

/** Map units from a point to segment `index`. */
function segmentDistance(
  segments: CoastSegments,
  index: number,
  x: number,
  y: number
): number {
  const at = index * 4;
  const ax = segments.points[at] ?? 0;
  const ay = segments.points[at + 1] ?? 0;
  const dx = (segments.points[at + 2] ?? 0) - ax;
  const dy = (segments.points[at + 3] ?? 0) - ay;
  const length = dx * dx + dy * dy;
  const t =
    length > 0
      ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length))
      : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

/** Twice the signed area of (u, v, w): positive when w lies left of u→v. */
function orient(
  ux: number,
  uy: number,
  vx: number,
  vy: number,
  wx: number,
  wy: number
): number {
  return (vx - ux) * (wy - uy) - (vy - uy) * (wx - ux);
}

/**
 * Whether segment `index` crosses the ray from (cx, cy) to (px, py). Each
 * side test counts a point on the line as the negative side, so where the
 * ray passes through a vertex the two segments meeting there agree, and
 * the crossing is counted once or not at all.
 */
function crosses(
  segments: CoastSegments,
  index: number,
  ray: { cx: number; cy: number; px: number; py: number }
): boolean {
  const at = index * 4;
  const ax = segments.points[at] ?? 0;
  const ay = segments.points[at + 1] ?? 0;
  const bx = segments.points[at + 2] ?? 0;
  const by = segments.points[at + 3] ?? 0;
  const { cx, cy, px, py } = ray;
  const c = orient(ax, ay, bx, by, cx, cy) > 0;
  const p = orient(ax, ay, bx, by, px, py) > 0;
  const a = orient(cx, cy, px, py, ax, ay) > 0;
  const b = orient(cx, cy, px, py, bx, by) > 0;
  return c !== p && a !== b;
}

/** Even-odd: whether a point lies inside an island's coast, holes kept. */
function insideCoast(island: TerrainIsland, x: number, y: number): boolean {
  let inside = false;
  const lx = x - island.x;
  const ly = y - island.y;
  for (const polygon of island.coast) {
    for (const ring of polygon) {
      for (
        let index = 0, last = ring.length - 1;
        index < ring.length;
        last = index, index += 1
      ) {
        const [ax = 0, ay = 0] = ring[index] ?? [];
        const [bx = 0, by = 0] = ring[last] ?? [];
        if (
          ay > ly !== by > ly &&
          lx < ((bx - ax) * (ly - ay)) / (by - ay) + ax
        ) {
          inside = !inside;
        }
      }
    }
  }
  return inside;
}

/** An island's coast's bounds in map units. */
function coastBounds(island: TerrainIsland) {
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
 * Bins over `grid` listing, for each, every segment some point inside it
 * could find nearest: with `near` the distance from the bin's centre to the
 * nearest segment and `half` half its diagonal, no point in the bin is
 * further than `near + half` from a coast, so no segment further than
 * `near + 2·half` from the centre can be its nearest. Every segment that
 * crosses the bin is within that too, so the ray from its corner meets no
 * segment the bin does not list. Bins beyond every island's bounds list
 * nothing and lie at sea.
 */
export function coastBins(
  islands: readonly TerrainIsland[],
  islandIds: readonly string[],
  segments: CoastSegments,
  grid: CoastBinGrid
): CoastBins {
  const count = grid.width * grid.height;
  const half = (grid.cell * Math.SQRT2) / 2;
  const near = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  const corner = new Uint8Array(count);
  const lists: number[][] = Array.from({ length: count }, () => []);
  const windows = binWindows(islands, islandIds, segments, grid);
  // First the nearest coast to each bin's centre and its corner's side,
  // then every segment within reach of the centre.
  visitBins(windows, grid, (window, at, x, y) => {
    for (const index of window.owned) {
      near[at] = Math.min(
        near[at] ?? 0,
        segmentDistance(segments, index, x, y)
      );
    }
    const cornerX = x - grid.cell / 2 + binCorner.x;
    const cornerY = y - grid.cell / 2 + binCorner.y;
    if (insideCoast(window.island, cornerX, cornerY)) {
      corner[at] = 1 - (corner[at] ?? 0);
    }
  });
  visitBins(windows, grid, (window, at, x, y) => {
    const reach = (near[at] ?? 0) + 2 * half + 1e-6;
    for (const index of window.owned) {
      if (segmentDistance(segments, index, x, y) <= reach) {
        lists[at]?.push(index);
      }
    }
  });
  const bins = new Uint32Array(count * 3);
  const list: number[] = [];
  for (let at = 0; at < count; at += 1) {
    const listed = lists[at] ?? [];
    bins[at * 3] = list.length;
    bins[at * 3 + 1] = listed.length;
    bins[at * 3 + 2] = corner[at] ?? 0;
    list.push(...listed);
  }
  return { ...grid, bins, list: Uint32Array.from(list) };
}

/** The bins round one island's coast, a bin beyond its bounds each way, and its segments. */
interface BinWindow {
  bottom: number;
  island: TerrainIsland;
  left: number;
  owned: readonly number[];
  right: number;
  top: number;
}

function binWindows(
  islands: readonly TerrainIsland[],
  islandIds: readonly string[],
  segments: CoastSegments,
  grid: CoastBinGrid
): BinWindow[] {
  const byIsland = islandIds.map(() => [] as number[]);
  for (let index = 0; index < segments.island.length; index += 1) {
    byIsland[segments.island[index] ?? 0]?.push(index);
  }
  return islands.map((island) => {
    const bounds = coastBounds(island);
    const column = (x: number) => Math.floor((x - grid.left) / grid.cell);
    const row = (y: number) => Math.floor((y - grid.top) / grid.cell);
    return {
      bottom: Math.min(grid.height - 1, row(bounds.bottom) + 1),
      island,
      left: Math.max(0, column(bounds.left) - 1),
      owned: byIsland[islandIds.indexOf(island.id)] ?? [],
      right: Math.min(grid.width - 1, column(bounds.right) + 1),
      top: Math.max(0, row(bounds.top) - 1),
    };
  });
}

/** Calls `visit` for every bin of every window, with the bin's index and centre. */
function visitBins(
  windows: readonly BinWindow[],
  grid: CoastBinGrid,
  visit: (window: BinWindow, at: number, x: number, y: number) => void
): void {
  for (const window of windows) {
    for (let row = window.top; row <= window.bottom; row += 1) {
      for (let column = window.left; column <= window.right; column += 1) {
        visit(
          window,
          row * grid.width + column,
          grid.left + (column + 0.5) * grid.cell,
          grid.top + (row + 0.5) * grid.cell
        );
      }
    }
  }
}

/** A position's coast: its signed distance, negative on land, and the island it lies on, -1 at sea. */
export interface CoastSample {
  /** Map units to the nearest coast, negative inside one; infinite in a bin that lists nothing. */
  distance: number;
  owner: number;
}

/**
 * The coast at a map position, as the shader measures it: the nearest
 * listed segment's distance, its island as the owner on land, and land
 * where the ray from the bin's corner crosses the coast an odd number of
 * times from a corner at sea, or an even number from one on land.
 */
export function coastDistance(
  bins: CoastBins,
  segments: CoastSegments,
  x: number,
  y: number
): CoastSample {
  const column = Math.floor((x - bins.left) / bins.cell);
  const row = Math.floor((y - bins.top) / bins.cell);
  if (column < 0 || row < 0 || column >= bins.width || row >= bins.height) {
    return { distance: Number.POSITIVE_INFINITY, owner: -1 };
  }
  const at = (row * bins.width + column) * 3;
  const start = bins.bins[at] ?? 0;
  const listed = bins.bins[at + 1] ?? 0;
  let inside = (bins.bins[at + 2] ?? 0) === 1;
  const ray = {
    cx: bins.left + column * bins.cell + binCorner.x,
    cy: bins.top + row * bins.cell + binCorner.y,
    px: x,
    py: y,
  };
  let nearest = Number.POSITIVE_INFINITY;
  let owner = -1;
  for (let index = start; index < start + listed; index += 1) {
    const segment = bins.list[index] ?? 0;
    const distance = segmentDistance(segments, segment, x, y);
    if (distance < nearest) {
      nearest = distance;
      owner = segments.island[segment] ?? -1;
    }
    if (crosses(segments, segment, ray)) {
      inside = !inside;
    }
  }
  return inside
    ? { distance: -nearest, owner }
    : { distance: nearest, owner: -1 };
}
