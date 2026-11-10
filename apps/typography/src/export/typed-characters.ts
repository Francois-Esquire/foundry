/** Reads what a person types into the character fields of an export plan. */
import type { CharacterSelector } from "~/packaging/export-plan";
import { parseCodePoint } from "~/unicode/code-point";

export interface TypedRanges {
  readonly selectors: readonly CharacterSelector[];
  /** Pieces that are neither a code point nor a range, as typed. */
  readonly unreadable: readonly string[];
}

const BETWEEN_PIECES = /[\s,;]+/;
const RANGE = /^(.+?)(?:-|\.\.|–)(.+)$/;

const readPiece = (piece: string): CharacterSelector | undefined => {
  const single = parseCodePoint(piece);
  if (single !== undefined) {
    return { codePoints: [single], kind: "characters" };
  }
  const [, from = "", to = ""] = RANGE.exec(piece) ?? [];
  const first = parseCodePoint(from);
  const last = parseCodePoint(to);
  return first === undefined || last === undefined
    ? undefined
    : {
        first: Math.min(first, last),
        kind: "range",
        last: Math.max(first, last),
      };
};

/**
 * Code points and ranges with commas or spaces between them:
 * "U+0041, U+0100-U+017F, 20AC".
 */
export const readRanges = (text: string): TypedRanges => {
  const selectors: CharacterSelector[] = [];
  const unreadable: string[] = [];
  for (const piece of text.split(BETWEEN_PIECES)) {
    if (piece === "") {
      continue;
    }
    const selector = readPiece(piece);
    if (selector) {
      selectors.push(selector);
    } else {
      unreadable.push(piece);
    }
  }
  return { selectors, unreadable };
};

/** Every distinct character of a text, in the order first typed. Line breaks are not characters to keep. */
export const charactersTyped = (text: string): number[] => [
  ...new Set(
    [...text.replaceAll(/[\r\n]/g, "")].map(
      (character) => character.codePointAt(0) ?? 0
    )
  ),
];
