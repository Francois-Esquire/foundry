/**
 * Contour following by marching squares. Each closed loop runs along the
 * edge between ink and paper, placed between pixel centres by their grey
 * levels, so an anti-aliased bitmap gives positions finer than a pixel.
 */
import type { Point } from "~/typeface/outline";
import { type Bitmap, inkAt } from "../raster/bitmap";

const TOP = 0;
const RIGHT = 1;
const BOTTOM = 2;
const LEFT = 3;

type Step = readonly [from: number, to: number];

/**
 * Steps through a cell by which corners hold ink (top-left 8, top-right 4,
 * bottom-right 2, bottom-left 1), walking with the ink on the right as the
 * bitmap is seen. The two saddle cells, 5 and 10, are decided separately.
 */
const STEPS: readonly (readonly Step[])[] = [
  [],
  [[LEFT, BOTTOM]],
  [[BOTTOM, RIGHT]],
  [[LEFT, RIGHT]],
  [[RIGHT, TOP]],
  [],
  [[BOTTOM, TOP]],
  [[LEFT, TOP]],
  [[TOP, LEFT]],
  [[TOP, BOTTOM]],
  [],
  [[TOP, RIGHT]],
  [[RIGHT, LEFT]],
  [[RIGHT, BOTTOM]],
  [[BOTTOM, LEFT]],
  [],
];

const SADDLE_STEPS: Readonly<
  Record<number, { joined: readonly Step[]; apart: readonly Step[] }>
> = {
  5: {
    apart: [
      [RIGHT, TOP],
      [LEFT, BOTTOM],
    ],
    joined: [
      [LEFT, TOP],
      [RIGHT, BOTTOM],
    ],
  },
  10: {
    apart: [
      [TOP, LEFT],
      [BOTTOM, RIGHT],
    ],
    joined: [
      [TOP, RIGHT],
      [BOTTOM, LEFT],
    ],
  },
};

/** The grid of pixel centres, with one ring of paper around the bitmap. */
class SampleGrid {
  readonly #bitmap: Bitmap;
  readonly #level: number;
  readonly columns: number;
  readonly rows: number;

  constructor(bitmap: Bitmap, threshold: number) {
    this.#bitmap = bitmap;
    this.#level = threshold - 0.5;
    this.columns = bitmap.width + 2;
    this.rows = bitmap.height + 2;
  }

  value(column: number, row: number) {
    return inkAt(this.#bitmap, column - 1, row - 1);
  }

  isInk(column: number, row: number) {
    return this.value(column, row) > this.#level;
  }

  /** Cell edges are numbered so that neighbouring cells share them. */
  edgeId(column: number, row: number, side: number) {
    const at = (c: number, r: number, vertical: number) =>
      2 * (r * this.columns + c) + vertical;
    if (side === TOP) {
      return at(column, row, 0);
    }
    if (side === BOTTOM) {
      return at(column, row + 1, 0);
    }
    return side === LEFT ? at(column, row, 1) : at(column + 1, row, 1);
  }

  /** Where the ink edge crosses a cell edge, in bitmap pixels with y down. */
  crossing(edgeId: number): Point {
    const vertical = edgeId % 2 === 1;
    const index = Math.floor(edgeId / 2);
    const column = index % this.columns;
    const row = Math.floor(index / this.columns);
    const a = this.value(column, row);
    const b = vertical
      ? this.value(column, row + 1)
      : this.value(column + 1, row);
    const t = a === b ? 0.5 : (this.#level - a) / (b - a);
    return vertical
      ? { x: column - 0.5, y: row - 0.5 + t }
      : { x: column - 0.5 + t, y: row - 0.5 };
  }

  stepsIn(column: number, row: number): readonly Step[] {
    const topLeft = this.isInk(column, row);
    const topRight = this.isInk(column + 1, row);
    const bottomRight = this.isInk(column + 1, row + 1);
    const bottomLeft = this.isInk(column, row + 1);
    const mask =
      (topLeft ? 8 : 0) +
      (topRight ? 4 : 0) +
      (bottomRight ? 2 : 0) +
      (bottomLeft ? 1 : 0);
    const saddle = SADDLE_STEPS[mask];
    if (!saddle) {
      return STEPS[mask] ?? [];
    }
    const centre =
      (this.value(column, row) +
        this.value(column + 1, row) +
        this.value(column + 1, row + 1) +
        this.value(column, row + 1)) /
      4;
    return centre > this.#level ? saddle.joined : saddle.apart;
  }
}

const linkEdges = (grid: SampleGrid): Int32Array => {
  const next = new Int32Array(2 * grid.columns * grid.rows).fill(-1);
  for (let row = 0; row < grid.rows - 1; row += 1) {
    for (let column = 0; column < grid.columns - 1; column += 1) {
      for (const [from, to] of grid.stepsIn(column, row)) {
        next[grid.edgeId(column, row, from)] = grid.edgeId(column, row, to);
      }
    }
  }
  return next;
};

/**
 * Every closed edge between ink and paper, as polygons in pixels with y up
 * from the bottom of the bitmap. Shapes come out counter-clockwise and the
 * counters inside them clockwise.
 */
export const followContours = (
  bitmap: Bitmap,
  threshold: number
): Point[][] => {
  const grid = new SampleGrid(bitmap, threshold);
  const next = linkEdges(grid);
  const loops: Point[][] = [];
  for (let start = 0; start < next.length; start += 1) {
    if ((next[start] ?? -1) < 0) {
      continue;
    }
    const loop: Point[] = [];
    let edge = start;
    while (edge >= 0 && (next[edge] ?? -1) >= 0) {
      const { x, y } = grid.crossing(edge);
      loop.push({ x, y: bitmap.height - y });
      const following = next[edge] ?? -1;
      next[edge] = -1;
      edge = following;
    }
    loops.push(loop);
  }
  return loops;
};
