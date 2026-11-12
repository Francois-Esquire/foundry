import { firstLetters } from "~/unicode/sample-text";

/** The line a specimen starts with, before anyone types their own. */

const TEST_WORD = "Hamburgefonstiv";
const SAMPLE_LENGTH = 12;
const FIRST_VISIBLE = 0x21;
const LETTER = /\p{L}/u;

interface CharacterSource {
  characters(): Uint32Array;
  glyphForCharacter(codePoint: number): number | undefined;
}

function* visibleLetters(characters: Uint32Array) {
  for (const codePoint of characters) {
    if (
      codePoint >= FIRST_VISIBLE &&
      LETTER.test(String.fromCodePoint(codePoint))
    ) {
      yield codePoint;
    }
  }
}

/**
 * A line that shows the glyph in company: the type designer's test word when
 * the face can set it, otherwise the first letters the face has. The glyph's
 * own character leads when the line would not contain it.
 */
export const specimenTextFor = (
  face: CharacterSource,
  glyphCharacters: readonly number[]
): string => {
  const canSetTestWord = [...TEST_WORD].every(
    (letter) => face.glyphForCharacter(letter.codePointAt(0) ?? 0) !== undefined
  );
  const line = canSetTestWord
    ? TEST_WORD
    : firstLetters(visibleLetters(face.characters()), SAMPLE_LENGTH).join("");
  const [own] = glyphCharacters;
  if (own === undefined || own < FIRST_VISIBLE) {
    return line;
  }
  const character = String.fromCodePoint(own);
  return line.includes(character) ? line : `${character}${line}`;
};
