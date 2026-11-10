/**
 * From pieces of ink to letters: pieces are sorted into lines, pieces that
 * belong to one letter are joined, and each line gets its letters in reading
 * order with a baseline and a body height.
 */

import { type Band, bandsOf } from "~/generation/extraction/bands";
import type { InkComponent } from "~/generation/extraction/components";
import { dominant } from "~/generation/extraction/straighten";
import {
  type Bitmap,
  boxWidth,
  type PixelBox,
  unionBox,
} from "~/generation/raster/bitmap";
import { median } from "~/generation/style/measure";
import { cutPieces, type InkPieces } from "./pieces";

export interface LetterShape {
  /** Ink pixels in the letter. */
  readonly area: number;
  /** The letter's ink alone, with `CUT_MARGIN` pixels of paper around its box. */
  readonly bitmap: Bitmap;
  /** Where the letter sits in the region's view, in pixels. */
  readonly box: PixelBox;
  /** The space between this letter and the one to its left on the line, in pixels. */
  readonly gapLeft?: number;
  /** How many separate pieces of ink were joined into this letter. */
  readonly parts: number;
  /**
   * Set when the shape is too wide to be one letter, which is what two
   * letters whose ink touches look like. It is kept as one shape and marked.
   */
  readonly runTogether: boolean;
  /** True when the edge of the line or a word space lies to the letter's left. */
  readonly spaceLeft: boolean;
}

export interface LetteringLine {
  /** The highest any letter reaches above the baseline, in pixels. */
  readonly ascent: number;
  /**
   * The y of the baseline in the region's view, in pixels from the top, at
   * the middle of the line. `baselineAt` follows it along a line that tilts.
   */
  readonly baseline: number;
  /**
   * Which line most letters' tops stand on. Capitals alone give the cap
   * height. Mixed case gives the x-height, with capitals and ascenders
   * above it. A line of lowercase letters with no ascender reads as capitals:
   * nothing in the picture tells the two apart.
   */
  readonly body: "cap-height" | "x-height";
  /** From the baseline to the tops of most letters, in pixels. */
  readonly bodyHeight: number;
  readonly letters: readonly LetterShape[];
  /** The x of the middle of the line, where `baseline` is measured. */
  readonly middle: number;
  /** How far the baseline drops for each pixel to the right. 0 for a level line. */
  readonly slope: number;
}

/** The y of a line's baseline under a given x of the view. */
export const baselineAt = (line: LetteringLine, x: number): number =>
  line.baseline + line.slope * (x - line.middle);

export interface LetterOptions {
  /** The order letters are read in along a line. Left to right when absent. */
  readonly direction?: "ltr" | "rtl";
  /**
   * Pieces side by side whose ink comes within this many pixels are one
   * letter with a broken stroke. A tenth of the stroke thickness when absent.
   */
  readonly joinGap?: number;
}

export interface FoundLetters {
  readonly lines: readonly LetteringLine[];
  /** Pieces of ink that sit on no line. */
  readonly stray: readonly PixelBox[];
}

/** A mark this small beside the line below it, and this close to it, belongs to that line. */
const MARK_HEIGHT = 0.35;
const MARK_GAP = 0.35;
/** Pieces whose spans across the line overlap by this share of the narrower one are stacked: one letter. */
const STACKED = 0.5;
/** Tops and feet within this share of the line's height stand on the same line. */
const LINE_TOLERANCE = 0.06;
/** Most letters reach at least this share of the tallest before the line counts as capitals. */
const CAPITALS = 0.85;
/** No single letter is wider than this many body heights. */
const WIDEST_LETTER = 1.7;
/** A gap this many times the usual one, and this share of the body height, parts two words. */
const WORD_GAP = 2;
const WORD_GAP_BODY = 0.25;

const bandHeight = (band: Band) => band.end - band.start;

/** Rows of the region that hold a line of lettering. Small marks join the line under them. */
const lineBands = (pieces: readonly InkComponent[]): Band[] => {
  const bands = bandsOf(
    pieces.map((piece) => ({ end: piece.box.bottom, start: piece.box.top })),
    0
  );
  const lines: Band[] = [];
  for (const [index, band] of bands.entries()) {
    const below = bands[index + 1];
    const isMark =
      below !== undefined &&
      bandHeight(band) < MARK_HEIGHT * bandHeight(below) &&
      below.start - band.end < MARK_GAP * bandHeight(below);
    if (isMark) {
      bands[index + 1] = { end: below.end, start: band.start };
    } else {
      lines.push(band);
    }
  }
  return lines;
};

interface Group {
  box: PixelBox;
  members: InkComponent[];
}

/** Whether any ink of one piece lies within `reach` pixels of the other's. */
const inkWithin = (
  { labelled }: InkPieces,
  a: InkComponent,
  b: InkComponent,
  reach: number
): boolean => {
  const span = Math.ceil(reach);
  const left = Math.max(a.box.left, b.box.left - span);
  const right = Math.min(a.box.right, b.box.right + span);
  const top = Math.max(a.box.top, b.box.top - span);
  const bottom = Math.min(a.box.bottom, b.box.bottom + span);
  const owner = (x: number, y: number) =>
    x < 0 || y < 0 || x >= labelled.width || y >= labelled.height
      ? 0
      : (labelled.labels[y * labelled.width + x] ?? 0);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (owner(x, y) !== a.id) {
        continue;
      }
      for (let dy = -span; dy <= span; dy += 1) {
        for (let dx = -span; dx <= span; dx += 1) {
          if (
            Math.hypot(dx, dy) <= reach + 1 &&
            owner(x + dx, y + dy) === b.id
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
};

/**
 * Pieces stacked over each other are one letter: a dot over its stem, an
 * accent, a stroke broken across. Pieces side by side are one letter only
 * when their ink all but touches, which is a stroke broken along the line.
 * Boxes alone cannot say that: the boxes of S and A overlap in tight setting.
 */
const belongTogether = (
  found: InkPieces,
  group: Group,
  piece: InkComponent,
  joinGap: number
): boolean => {
  const overlap =
    Math.min(group.box.right, piece.box.right) -
    Math.max(group.box.left, piece.box.left);
  if (overlap >= STACKED * Math.min(boxWidth(group.box), boxWidth(piece.box))) {
    return true;
  }
  return (
    -overlap <= joinGap &&
    group.members.some((member) => inkWithin(found, member, piece, joinGap))
  );
};

/** Joins the pieces of one line into letters, left to right. */
const groupPieces = (
  found: InkPieces,
  pieces: readonly InkComponent[],
  joinGap: number
): Group[] => {
  const groups: Group[] = [];
  for (const piece of pieces.toSorted((a, b) => a.box.left - b.box.left)) {
    const home = groups.find((group) =>
      belongTogether(found, group, piece, joinGap)
    );
    if (home) {
      home.box = unionBox(home.box, piece.box);
      home.members.push(piece);
    } else {
      groups.push({ box: piece.box, members: [piece] });
    }
  }
  return groups.toSorted((a, b) => a.box.left - b.box.left);
};

const spanOf = (boxes: readonly PixelBox[]): PixelBox => boxes.reduce(unionBox);

const centreOf = (box: PixelBox) => (box.left + box.right) / 2;

/** Letters closer than this many body heights say too little about the tilt to count. */
const TILT_SPAN = 1.5;
/** With fewer letters than this, one descender is enough to turn the line, so it is taken as level. */
const TILT_LETTERS = 5;

/**
 * The tilt of a line: the middle slope among all pairs of letters' feet far
 * enough apart (Theil-Sen), so round letters that dip below the baseline and
 * descenders do not turn it.
 */
const slopeOf = (boxes: readonly PixelBox[], height: number): number => {
  if (boxes.length < TILT_LETTERS) {
    return 0;
  }
  const slopes: number[] = [];
  for (const [index, a] of boxes.entries()) {
    for (const b of boxes.slice(index + 1)) {
      const run = centreOf(b) - centreOf(a);
      if (Math.abs(run) >= TILT_SPAN * height) {
        slopes.push((b.bottom - a.bottom) / run);
      }
    }
  }
  return median(slopes) ?? 0;
};

const wordGapOf = (gaps: readonly number[], bodyHeight: number): number =>
  Math.max(WORD_GAP * (median(gaps) ?? 0), WORD_GAP_BODY * bodyHeight);

const lineOf = (
  found: InkPieces,
  pieces: readonly InkComponent[],
  band: Band,
  options: LetterOptions
): LetteringLine => {
  const joinGap = options.joinGap ?? found.strokeThickness / 10;
  const groups = groupPieces(found, pieces, joinGap);
  const tolerance = Math.max(1, LINE_TOLERANCE * bandHeight(band));
  const boxes = groups.map((group) => group.box);
  const middle = (spanOf(boxes).left + spanOf(boxes).right) / 2;
  const slope = slopeOf(boxes, bandHeight(band));
  const level = (y: number, box: PixelBox) =>
    y - slope * (centreOf(box) - middle);
  const baseline =
    dominant(
      boxes.map((box) => level(box.bottom, box)),
      tolerance
    ) ?? band.end;
  const top =
    dominant(
      boxes.map((box) => level(box.top, box)),
      tolerance
    ) ?? band.start;
  const ascent =
    baseline - Math.min(...boxes.map((box) => level(box.top, box)));
  const bodyHeight = Math.max(1, baseline - top);
  const gaps = groups
    .slice(1)
    .map((group, index) => group.box.left - (groups[index]?.box.right ?? 0));
  const wordGap = wordGapOf(gaps, bodyHeight);
  const letters = groups.map((group, index): LetterShape => {
    const gapLeft = index === 0 ? undefined : gaps[index - 1];
    return {
      area: group.members.reduce((sum, member) => sum + member.area, 0),
      bitmap: cutPieces(
        found,
        group.members.map((member) => member.id),
        group.box
      ),
      box: group.box,
      gapLeft,
      parts: group.members.length,
      runTogether: boxWidth(group.box) > WIDEST_LETTER * bodyHeight,
      spaceLeft: gapLeft === undefined || gapLeft > wordGap,
    };
  });
  return {
    ascent,
    baseline,
    body: bodyHeight >= CAPITALS * ascent ? "cap-height" : "x-height",
    bodyHeight,
    letters: options.direction === "rtl" ? letters.toReversed() : letters,
    middle,
    slope,
  };
};

/** Sorts the pieces of a region into lines of letters, in reading order. */
export const findLetters = (
  found: InkPieces,
  options: LetterOptions = {}
): FoundLetters => {
  const bands = lineBands(found.pieces);
  const tallest = Math.max(0, ...bands.map(bandHeight));
  const lines: LetteringLine[] = [];
  const stray: PixelBox[] = [];
  for (const band of bands) {
    const pieces = found.pieces.filter(
      (piece) => piece.box.top >= band.start && piece.box.bottom <= band.end
    );
    // A band far shorter than the lettering is debris the speck limit let by.
    if (bandHeight(band) < MARK_HEIGHT * tallest) {
      stray.push(...pieces.map((piece) => piece.box));
      continue;
    }
    lines.push(lineOf(found, pieces, band, options));
  }
  return { lines, stray };
};
