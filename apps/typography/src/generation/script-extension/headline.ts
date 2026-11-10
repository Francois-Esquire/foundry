/**
 * Reads the structure of a headline script from a picture of a letter or a
 * syllable: where the headline is, which strokes hang from it, and where the
 * ink under it breaks into separate parts.
 */
import { type Bitmap, INK_THRESHOLD, inkAt } from "../raster/bitmap";

/** A band of pixel rows and the columns its ink spans. Ends are exclusive. */
export interface HeadlineBand {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

/** A stretch of pixels along a row or across columns. `end` is exclusive. */
export interface Span {
  readonly end: number;
  readonly start: number;
}

/** A level stroke is at least this many times as long as the headline is thick. */
const LEVEL_LENGTH = 2;
/** Its ends stay within this share of the headline's thickness from row to row. */
const LEVEL_ENDS = 0.15;
/** It is at least this share of the headline's thickness deep. */
const LEVEL_DEPTH = 0.5;
/** Strokes this share as long as the longest one hanging from the headline are stems too. */
const FULL_STEM = 0.9;

export const isInk = (bitmap: Bitmap, x: number, y: number) =>
  inkAt(bitmap, x, y) >= INK_THRESHOLD;

/** The runs of ink along a row, left to right. */
const inkRunsInRow = (bitmap: Bitmap, row: number): Span[] => {
  const runs: Span[] = [];
  let start: number | undefined;
  for (let x = 0; x <= bitmap.width; x += 1) {
    const ink = x < bitmap.width && isInk(bitmap, x, row);
    if (ink && start === undefined) {
      start = x;
    } else if (!ink && start !== undefined) {
      runs.push({ end: x, start });
      start = undefined;
    }
  }
  return runs;
};

const spanLength = (span: Span | undefined) =>
  span ? span.end - span.start : 0;

const longestSpan = (spans: readonly Span[]): Span | undefined =>
  spans.reduce<Span | undefined>(
    (best, span) => (spanLength(best) >= spanLength(span) ? best : span),
    undefined
  );

const sameEnds = (a: Span, b: Span, slack: number) =>
  Math.abs(a.start - b.start) <= slack && Math.abs(a.end - b.end) <= slack;

/** How many rows, from `row` down, hold a run with the same ends as `run`. */
const depthOfRun = (
  bitmap: Bitmap,
  run: Span,
  row: number,
  slack: number
): number => {
  let below = row + 1;
  while (
    below < bitmap.height &&
    inkRunsInRow(bitmap, below).some((other) => sameEnds(run, other, slack))
  ) {
    below += 1;
  }
  return below - row;
};

/**
 * The first row of a stroke whose ends settle at `row`: a rounded or notched
 * end leaves a few rows above it that are the same stroke, a little shorter.
 */
const topOfStroke = (bitmap: Bitmap, run: Span, row: number): number => {
  const covers = (other: Span) =>
    Math.min(other.end, run.end) - Math.max(other.start, run.start) >=
    spanLength(run) / 2;
  let top = row;
  while (top > 0 && inkRunsInRow(bitmap, top - 1).some(covers)) {
    top -= 1;
  }
  return top;
};

/**
 * The headline: the highest level stroke in the picture. A level stroke is a
 * run of ink that keeps its two ends row after row. The top of a round bowl
 * or of a hook widens as it goes down and a slanted mark moves sideways, so
 * neither is taken for it, however wide. `thickness` is how thick a headline
 * is expected to be, in pixels.
 */
export const findHeadline = (
  bitmap: Bitmap,
  thickness: number
): HeadlineBand | undefined => {
  const slack = LEVEL_ENDS * thickness;
  for (let row = 0; row < bitmap.height; row += 1) {
    const level = inkRunsInRow(bitmap, row)
      .filter((run) => spanLength(run) >= LEVEL_LENGTH * thickness)
      .map((run) => ({ depth: depthOfRun(bitmap, run, row, slack), run }))
      .filter(({ depth }) => depth >= LEVEL_DEPTH * thickness)
      .toSorted((a, b) => spanLength(b.run) - spanLength(a.run))
      .at(0);
    if (level) {
      return {
        bottom: row + level.depth,
        left: level.run.start,
        right: level.run.end,
        top: topOfStroke(bitmap, level.run, row),
      };
    }
  }
};

/**
 * The headline of a glyph that already stands on known lines: among the runs
 * of ink in the middle row of the band, the longest that keeps its ends
 * through the middle half of the band.
 */
export const headlineBetween = (
  bitmap: Bitmap,
  top: number,
  bottom: number
): HeadlineBand | undefined => {
  const quarter = (bottom - top) / 4;
  const from = Math.round(top + quarter);
  const depth = Math.max(1, Math.round(2 * quarter));
  const slack = LEVEL_ENDS * (bottom - top);
  const run = longestSpan(
    inkRunsInRow(bitmap, from).filter(
      (candidate) => depthOfRun(bitmap, candidate, from, slack) >= depth
    )
  );
  return run && { bottom, left: run.start, right: run.end, top };
};

/** How far down unbroken ink runs in a column, starting at a row. */
const hangingLength = (bitmap: Bitmap, x: number, from: number): number => {
  let row = from;
  while (row < bitmap.height && isInk(bitmap, x, row)) {
    row += 1;
  }
  return row - from;
};

/** Groups neighbouring columns into spans. */
const spansOf = (columns: readonly number[]): Span[] => {
  const spans: Span[] = [];
  for (const column of columns) {
    const last = spans.at(-1);
    if (last && last.end === column) {
      spans[spans.length - 1] = { end: column + 1, start: last.start };
    } else {
      spans.push({ end: column + 1, start: column });
    }
  }
  return spans;
};

/**
 * The main stem: the longest stroke hanging from the headline, and the
 * rightmost one when several are as long, as the stem of a letter in these
 * scripts stands on its right. Marks attach over it and under it.
 */
export const findMainStem = (
  bitmap: Bitmap,
  band: HeadlineBand
): Span | undefined => {
  const lengths = Array.from({ length: bitmap.width }, (_, x) =>
    x >= band.left && x < band.right ? hangingLength(bitmap, x, band.bottom) : 0
  );
  const longest = Math.max(0, ...lengths);
  if (longest === 0) {
    return;
  }
  const columns = lengths.flatMap((length, x) =>
    length >= FULL_STEM * longest ? [x] : []
  );
  return spansOf(columns).at(-1);
};

/**
 * The parts the ink under the headline falls into, left to right: stretches
 * of columns with ink below the band, apart from each other by clear paper.
 * `skip` rows right under the headline are left out, so the rounding where a
 * stroke meets the headline does not bridge two parts.
 */
export const partsUnderHeadline = (
  bitmap: Bitmap,
  band: HeadlineBand,
  skip: number
): Span[] => {
  const columns: number[] = [];
  for (let x = 0; x < bitmap.width; x += 1) {
    for (let y = band.bottom + skip; y < bitmap.height; y += 1) {
      if (isInk(bitmap, x, y)) {
        columns.push(x);
        break;
      }
    }
  }
  return spansOf(columns);
};

/** How much ink each column holds below the headline. */
export const inkUnderHeadline = (
  bitmap: Bitmap,
  band: HeadlineBand
): number[] =>
  Array.from({ length: bitmap.width }, (_, x) => {
    let count = 0;
    for (let y = band.bottom; y < bitmap.height; y += 1) {
      if (isInk(bitmap, x, y)) {
        count += 1;
      }
    }
    return count;
  });
