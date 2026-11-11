/**
 * The normal form two shapes are compared in: a small grey grid where the
 * baseline is always the same row and the line's body height is always the
 * same number of rows. Position and scale are taken out; relative size is
 * kept, so a small o does not pass for a capital O.
 */
import type { Bitmap } from "~/generation/raster/bitmap";
import { inkAt } from "~/generation/raster/bitmap";
import { rasterizePolygons } from "~/generation/raster/rasterize";
import {
  type Outline,
  outlineBounds,
  transformOutline,
} from "~/typeface/outline";
import { flattenOutline } from "~/typeface/outline-geometry";
import {
  baselineAt,
  type LetteringLine,
  type LetterShape,
} from "../isolation/letters";
import { CUT_MARGIN } from "../isolation/pieces";

/** Rows the body height takes in the grid. */
const BODY = 24;
/** Rows kept above the baseline: the body and half as much again, for ascenders and marks. */
const ABOVE = BODY * 1.5;
/** Rows kept below the baseline, for descenders. */
const BELOW = BODY * 0.5;
/** Columns: wide enough for the widest letter at the widest stretch tried. */
const WIDTH = BODY * 2.5;
const HEIGHT = ABOVE + BELOW;
const SAMPLES = 3;

/** A shape in normal form, with the box its ink occupies so comparing skips the empty cells. */
export interface NormalForm {
  /** Exclusive. */
  readonly bottom: number;
  /** Grey levels 0 to 255, `WIDTH` by `HEIGHT`, row-major. */
  readonly cells: Uint8Array;
  readonly left: number;
  /** Exclusive. */
  readonly right: number;
  readonly top: number;
  /** The sum of all cells. */
  readonly total: number;
}

const formOf = (cells: Uint8Array): NormalForm => {
  let left = WIDTH;
  let right = 0;
  let top = HEIGHT;
  let bottom = 0;
  let total = 0;
  for (let row = 0; row < HEIGHT; row += 1) {
    for (let column = 0; column < WIDTH; column += 1) {
      const value = cells[row * WIDTH + column] ?? 0;
      if (value > 0) {
        total += value;
        left = Math.min(left, column);
        right = Math.max(right, column + 1);
        top = Math.min(top, row);
        bottom = Math.max(bottom, row + 1);
      }
    }
  }
  return { bottom, cells, left, right, top, total };
};

/** An isolated letter in normal form, centred across the grid. */
export const normaliseLetter = (
  letter: LetterShape,
  line: LetteringLine
): NormalForm => {
  const perCell = line.bodyHeight / BODY;
  const centre = (letter.box.left + letter.box.right) / 2;
  const baseline = baselineAt(line, centre);
  const cells = new Uint8Array(WIDTH * HEIGHT);
  for (let row = 0; row < HEIGHT; row += 1) {
    for (let column = 0; column < WIDTH; column += 1) {
      let inked = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x =
            centre + (column + (sx + 0.5) / SAMPLES - WIDTH / 2) * perCell;
          const y = baseline + (row + (sy + 0.5) / SAMPLES - ABOVE) * perCell;
          inked +=
            inkAt(
              letter.bitmap,
              Math.floor(x) - letter.box.left + CUT_MARGIN,
              Math.floor(y) - letter.box.top + CUT_MARGIN
            ) >= 128
              ? 1
              : 0;
        }
      }
      cells[row * WIDTH + column] = Math.round(
        (255 * inked) / (SAMPLES * SAMPLES)
      );
    }
  }
  return formOf(cells);
};

/**
 * A glyph in normal form. `bodyHeight` is the face's cap height or x-height
 * in font units, whichever the line was measured by. `widthFactor` stretches
 * the glyph across, the same for every glyph of a face, so a condensed
 * design can be compared with a face of normal width.
 */
export const normaliseOutline = (
  outline: Outline,
  bodyHeight: number,
  widthFactor: number
): NormalForm | undefined => {
  const bounds = outlineBounds(outline);
  if (!bounds || bodyHeight <= 0) {
    return;
  }
  const scale = BODY / bodyHeight;
  const centre = (bounds.xMin + bounds.xMax) / 2;
  const placed = transformOutline(outline, {
    dx: WIDTH / 2 - centre * scale * widthFactor,
    dy: ABOVE,
    xx: scale * widthFactor,
    xy: 0,
    yx: 0,
    yy: -scale,
  });
  const drawn: Bitmap = rasterizePolygons(
    flattenOutline(placed, 0.05),
    WIDTH,
    HEIGHT,
    { antialias: true }
  );
  return formOf(drawn.data);
};

/** The ink two forms share with `b` moved by (dx, dy), counted in grey levels. */
const sharedInk = (
  a: NormalForm,
  b: NormalForm,
  dx: number,
  dy: number
): number => {
  const top = Math.max(a.top, b.top + dy);
  const bottom = Math.min(a.bottom, b.bottom + dy);
  const left = Math.max(a.left, b.left + dx);
  const right = Math.min(a.right, b.right + dx);
  let shared = 0;
  for (let row = top; row < bottom; row += 1) {
    const mineAt = row * WIDTH;
    const theirsAt = (row - dy) * WIDTH - dx;
    for (let column = left; column < right; column += 1) {
      const mine = a.cells[mineAt + column] ?? 0;
      const theirs = b.cells[theirsAt + column] ?? 0;
      shared += mine < theirs ? mine : theirs;
    }
  }
  return shared;
};

/**
 * How well two normal forms agree, 0 to 1: shared ink over all ink, counted
 * in grey levels. With `slack`, `b` is tried one cell either way and the best
 * is taken, so a baseline that is a pixel off does not decide the answer.
 */
export const agreement = (
  a: NormalForm,
  b: NormalForm,
  slack: 0 | 1 = 1
): number => {
  let best = 0;
  for (let dy = -slack; dy <= slack; dy += 1) {
    for (let dx = -slack; dx <= slack; dx += 1) {
      best = Math.max(best, sharedInk(a, b, dx, dy));
    }
  }
  const all = a.total + b.total - best;
  return all <= 0 ? 0 : best / all;
};
