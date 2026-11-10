/**
 * Splits text into runs that each read one way. A shaper lays out one
 * direction at a time, so mixed text, such as Hebrew with a Latin word or
 * Arabic with a number, has to be split before it is shaped.
 *
 * This is the common core of the Unicode bidirectional algorithm: letters set
 * a direction, digits read left to right, and spaces and punctuation follow
 * their neighbours. Embedding controls and mirrored brackets are not handled.
 */
import type { TextDirection } from "./reading";

export interface DirectionRun {
  readonly direction: TextDirection;
  /** One past the last UTF-16 code unit of the run. */
  readonly end: number;
  /** The first UTF-16 code unit of the run. */
  readonly start: number;
}

/** Hebrew, Arabic and the other right-to-left blocks. */
const RIGHT_TO_LEFT = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const DIGIT = /\p{Nd}/u;
const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;

type Kind = "digit" | "ltr" | "neutral" | "rtl";

interface Piece {
  readonly end: number;
  readonly kind: Kind;
  readonly start: number;
}

const kindOf = (character: string, previous: Kind): Kind => {
  // A combining mark stays with the letter it sits on.
  if (MARK.test(character)) {
    return previous;
  }
  if (DIGIT.test(character)) {
    return "digit";
  }
  if (RIGHT_TO_LEFT.test(character)) {
    return "rtl";
  }
  return LETTER.test(character) ? "ltr" : "neutral";
};

const piecesOf = (text: string): Piece[] => {
  const pieces: Piece[] = [];
  let previous: Kind = "neutral";
  let start = 0;
  for (const character of text) {
    const kind = kindOf(character, previous);
    pieces.push({ end: start + character.length, kind, start });
    previous = kind;
    start += character.length;
  }
  return pieces;
};

const strongOf = (kind: Kind): TextDirection | undefined => {
  if (kind === "neutral") {
    return;
  }
  return kind === "rtl" ? "rtl" : "ltr";
};

/** The way a paragraph reads: the direction of its first letter. */
export const paragraphDirection = (text: string): TextDirection => {
  const first = piecesOf(text).find(
    (piece) => piece.kind === "ltr" || piece.kind === "rtl"
  );
  return first?.kind === "rtl" ? "rtl" : "ltr";
};

/** Gives spaces and punctuation the direction both neighbours share, or the paragraph's. */
const resolve = (
  pieces: readonly Piece[],
  paragraph: TextDirection
): TextDirection[] => {
  const directions = pieces.map((piece) => strongOf(piece.kind));
  let before = paragraph;
  for (let index = 0; index < directions.length; index += 1) {
    const known = directions[index];
    if (known) {
      before = known;
      continue;
    }
    let next = index;
    while (next < directions.length && !directions[next]) {
      next += 1;
    }
    const after = directions[next] ?? paragraph;
    directions.fill(before === after ? before : paragraph, index, next);
    index = next - 1;
  }
  return directions.map((direction) => direction ?? paragraph);
};

/**
 * The runs of a line in the order they sit on it, left to right. Pass a base
 * direction to override the one the text's first letter gives.
 */
export const directionRuns = (
  text: string,
  base?: TextDirection
): DirectionRun[] => {
  const pieces = piecesOf(text);
  const paragraph = base ?? paragraphDirection(text);
  const directions = resolve(pieces, paragraph);
  const runs: DirectionRun[] = [];
  pieces.forEach((piece, index) => {
    const direction = directions[index] ?? paragraph;
    const last = runs.at(-1);
    if (last?.direction === direction) {
      runs[runs.length - 1] = { ...last, end: piece.end };
    } else {
      runs.push({ direction, end: piece.end, start: piece.start });
    }
  });
  return paragraph === "rtl" ? runs.reverse() : runs;
};
