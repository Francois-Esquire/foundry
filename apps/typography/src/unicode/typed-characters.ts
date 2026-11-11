/**
 * Reads the characters a person typed. There are two things a person types:
 * a list of the characters they mean, and a text whose characters they mean.
 */
import { parseCodePoint } from "./code-point";

const SEPARATOR = /[\s,]+/u;
const NOTATION = /^(?:u\+|0x)[0-9a-f]{1,6}$/i;
/** Controls, format characters and separators draw nothing to generate. */
const INVISIBLE = /^[\p{Cc}\p{Cf}\p{Z}]$/u;

/**
 * The distinct characters of a typed list, in the order typed. Characters
 * can be typed themselves or written as U+00E9 or 0xE9, separated by spaces
 * or commas. A base letter followed by a combining mark is read as the one
 * accented character when Unicode has it.
 */
export const readTypedCharacters = (text: string): number[] => {
  const found = new Set<number>();
  for (const token of text.split(SEPARATOR)) {
    const written = NOTATION.test(token) ? parseCodePoint(token) : undefined;
    if (written !== undefined) {
      found.add(written);
      continue;
    }
    for (const character of token.normalize("NFC")) {
      if (!INVISIBLE.test(character)) {
        found.add(character.codePointAt(0) ?? 0);
      }
    }
  }
  return [...found];
};

/**
 * Every distinct character of a typed text, in the order first typed. A
 * space is a character like any other. A line break is not one to keep.
 */
export const charactersTyped = (text: string): number[] => [
  ...new Set(
    [...text.replaceAll(/[\r\n]/g, "")].map(
      (character) => character.codePointAt(0) ?? 0
    )
  ),
];
