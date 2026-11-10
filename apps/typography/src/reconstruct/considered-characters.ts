/**
 * Which characters a found shape may be read as. A reading means nothing
 * without this list: with figures allowed, a condensed O reads as a zero.
 */

export type Considered = "capitals" | "letters" | "letters-and-figures";

const CAPITALS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SMALL = "abcdefghijklmnopqrstuvwxyz";
const FIGURES = "0123456789";

const codePointsOf = (text: string): number[] =>
  [...text].map((character) => character.codePointAt(0) ?? 0);

const SETS: Readonly<Record<Considered, readonly number[]>> = {
  capitals: codePointsOf(CAPITALS),
  letters: codePointsOf(CAPITALS + SMALL),
  "letters-and-figures": codePointsOf(CAPITALS + SMALL + FIGURES),
};

export const CONSIDERED_OPTIONS: readonly {
  readonly label: string;
  readonly value: Considered;
}[] = [
  { label: "Capitals", value: "capitals" },
  { label: "Letters", value: "letters" },
  { label: "Letters and figures", value: "letters-and-figures" },
];

export const consideredCharacters = (considered: Considered) =>
  SETS[considered];

/** The one character a person typed as a label: the last they typed that is not a space. */
export const typedCharacter = (text: string): number | undefined =>
  [...text]
    .filter((character) => character.trim() !== "")
    .at(-1)
    ?.codePointAt(0);

/**
 * The basic alphabet a reconstruction is completed to: the capitals, and the
 * small letters too once any small letter was observed. Observed characters
 * are left out, since nothing is inferred for them.
 */
export const missingFromAlphabet = (observed: readonly number[]): string => {
  const seen = new Set(observed);
  const hasSmall = codePointsOf(SMALL).some((character) => seen.has(character));
  return [...(hasSmall ? CAPITALS + SMALL : CAPITALS)]
    .filter((letter) => !seen.has(letter.codePointAt(0) ?? 0))
    .join("");
};

/** The distinct characters of a typed list, in the order typed, spaces dropped. */
export const wantedCharacters = (text: string): number[] => [
  ...new Set(
    [...text.normalize("NFC")]
      .filter((character) => character.trim() !== "")
      .map((character) => character.codePointAt(0) ?? 0)
  ),
];
