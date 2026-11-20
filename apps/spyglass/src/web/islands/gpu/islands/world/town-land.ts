import type { Point, Polygon, Ring } from "../../../data/chart";

export const CELL = 0.5;
export const FREE = -1;
export const STREET = -2;
const PAD_CELLS = 2;
const DIAGONAL = Math.SQRT2;

export interface Land {
  readonly centre: Point;
  readonly clear: Float32Array;
  readonly cols: number;
  readonly cos: number;
  readonly margin: number;
  readonly rows: number;
  readonly sin: number;
  readonly taken: Int32Array;
  readonly u0: number;
  readonly v0: number;
}

export const toChart = (land: Land, u: number, v: number): Point => [
  land.centre[0] + u * land.cos - v * land.sin,
  land.centre[1] + u * land.sin + v * land.cos,
];

export const directionToChart = (land: Land, du: number, dv: number): Point => [
  du * land.cos - dv * land.sin,
  du * land.sin + dv * land.cos,
];

function momentsOf(ring: Ring) {
  let area = 0;
  let x = 0;
  let y = 0;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const [index, [x0, y0]] of ring.entries()) {
    const [x1, y1] = ring[(index + 1) % ring.length] ?? [x0, y0];
    const cross = x0 * y1 - x1 * y0;
    area += cross / 2;
    x += ((x0 + x1) * cross) / 6;
    y += ((y0 + y1) * cross) / 6;
    xx += ((x0 * x0 + x0 * x1 + x1 * x1) * cross) / 12;
    yy += ((y0 * y0 + y0 * y1 + y1 * y1) * cross) / 12;
    xy += ((x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cross) / 24;
  }
  if (Math.abs(area) < 1e-9) {
    const [first] = ring;
    return { angle: 0, area: 0, centre: first ?? ([0, 0] as Point) };
  }
  const cx = x / area;
  const cy = y / area;
  const sxx = xx / area - cx * cx;
  const syy = yy / area - cy * cy;
  const sxy = xy / area - cx * cy;
  const angle = Math.atan2(2 * sxy, sxx - syy) / 2;
  return { angle, area: Math.abs(area), centre: [cx, cy] as Point };
}

function crossingsOf(
  rings: readonly (readonly (readonly [number, number])[])[],
  v0: number,
  rows: number
): number[][] {
  const crossings: number[][] = Array.from({ length: rows }, () => []);
  for (const ring of rings) {
    for (const [index, [ua, va]] of ring.entries()) {
      const [ub, vb] = ring[(index + 1) % ring.length] ?? [ua, va];
      const first = Math.max(
        Math.ceil((Math.min(va, vb) - v0) / CELL - 0.5),
        0
      );
      const last = Math.min(
        Math.floor((Math.max(va, vb) - v0) / CELL - 0.5),
        rows - 1
      );
      for (let j = first; j <= last; j += 1) {
        const v = v0 + (j + 0.5) * CELL;
        if (va > v !== vb > v) {
          crossings[j]?.push(ua + ((v - va) * (ub - ua)) / (vb - va));
        }
      }
    }
  }
  for (const row of crossings) {
    row.sort((a, b) => a - b);
  }
  return crossings;
}

function chamfer(clear: Float32Array, cols: number, rows: number) {
  const look = (i: number, j: number): number =>
    i < 0 || j < 0 || i >= cols || j >= rows
      ? 0
      : (clear[j * cols + i] ?? Number.POSITIVE_INFINITY);
  const pass = (forward: boolean) => {
    const step = forward ? 1 : -1;
    for (let n = 0; n < rows; n += 1) {
      const j = forward ? n : rows - 1 - n;
      for (let m = 0; m < cols; m += 1) {
        const i = forward ? m : cols - 1 - m;
        const index = j * cols + i;
        const here = clear[index] ?? 0;
        if (here === 0) {
          continue;
        }
        clear[index] = Math.min(
          here,
          look(i - step, j) + 1,
          look(i, j - step) + 1,
          look(i - step, j - step) + DIAGONAL,
          look(i + step, j - step) + DIAGONAL
        );
      }
    }
  };
  pass(true);
  pass(false);
}

export function landOf(polygon: Polygon, margin: number): Land {
  const { centre, angle } = momentsOf(polygon.outer);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rings = [polygon.outer, ...polygon.holes].map((ring) =>
    ring.map(
      ([x, y]) =>
        [
          (x - centre[0]) * cos + (y - centre[1]) * sin,
          -(x - centre[0]) * sin + (y - centre[1]) * cos,
        ] as const
    )
  );
  const us = rings.flat().map(([u]) => u);
  const vs = rings.flat().map(([, v]) => v);
  const u0 = Math.min(...us) - PAD_CELLS * CELL;
  const v0 = Math.min(...vs) - PAD_CELLS * CELL;
  const cols = Math.ceil((Math.max(...us) - u0) / CELL) + PAD_CELLS;
  const rows = Math.ceil((Math.max(...vs) - v0) / CELL) + PAD_CELLS;
  const clear = new Float32Array(cols * rows);
  for (const [j, crossings] of crossingsOf(rings, v0, rows).entries()) {
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.ceil(((crossings[k] ?? 0) - u0) / CELL - 0.5);
      const to = Math.floor(((crossings[k + 1] ?? 0) - u0) / CELL - 0.5);
      for (let i = Math.max(from, 0); i <= Math.min(to, cols - 1); i += 1) {
        clear[j * cols + i] = Number.POSITIVE_INFINITY;
      }
    }
  }
  chamfer(clear, cols, rows);
  for (let index = 0; index < clear.length; index += 1) {
    clear[index] = (clear[index] ?? 0) * CELL;
  }
  const taken = new Int32Array(cols * rows).fill(FREE);
  return { centre, clear, cols, cos, margin, rows, sin, taken, u0, v0 };
}

export function cellAt(land: Land, u: number, v: number): number {
  const i = Math.floor((u - land.u0) / CELL);
  const j = Math.floor((v - land.v0) / CELL);
  if (i < 0 || j < 0 || i >= land.cols || j >= land.rows) {
    return -1;
  }
  return j * land.cols + i;
}

export const isBuildable = (land: Land, cell: number): boolean =>
  cell >= 0 && (land.clear[cell] ?? 0) >= land.margin;

export function heartOf(land: Land): Point {
  let best = 0;
  let bestCell = -1;
  for (let cell = 0; cell < land.clear.length; cell += 1) {
    const clear = land.clear[cell] ?? 0;
    if (clear > best) {
      best = clear;
      bestCell = cell;
    }
  }
  const i = Math.max(bestCell, 0) % land.cols;
  const j = Math.floor(Math.max(bestCell, 0) / land.cols);
  return [land.u0 + (i + 0.5) * CELL, land.v0 + (j + 0.5) * CELL];
}
