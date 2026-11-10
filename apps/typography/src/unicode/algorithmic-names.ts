/**
 * Names Unicode derives by rule instead of listing: a prefix followed by the
 * code point in hexadecimal (CJK unified ideographs and similar), and Hangul
 * syllables, spelled from their jamo.
 */

/** A range whose names are `prefix` followed by the code point in hex. */
export interface NameRule {
  readonly first: number;
  readonly last: number;
  readonly prefix: string;
}

const HANGUL_FIRST = 0xac_00;
const HANGUL_LAST = 0xd7_a3;
const HANGUL_PREFIX = "HANGUL SYLLABLE ";
const VOWEL_COUNT = 21;
const TRAILING_COUNT = 28;

// Jamo short names from the Unicode Standard, section 3.12.
const LEADING = "G GG N D DD R M B BB S SS  J JJ C K T P H".split(" ");
const VOWELS =
  "A AE YA YAE EO E YEO YE O WA WAE OE YO U WEO WE WI YU EU YI I".split(" ");
const TRAILING =
  " G GG GS N NJ NH D L LG LM LB LS LT LP LH M B BS S SS NG J C K T P H".split(
    " "
  );

export const isHangulSyllable = (codePoint: number) =>
  codePoint >= HANGUL_FIRST && codePoint <= HANGUL_LAST;

export const hangulSyllableName = (codePoint: number): string => {
  const offset = codePoint - HANGUL_FIRST;
  const leading = Math.floor(offset / (VOWEL_COUNT * TRAILING_COUNT));
  const vowel = Math.floor(offset / TRAILING_COUNT) % VOWEL_COUNT;
  const trailing = offset % TRAILING_COUNT;
  return `${HANGUL_PREFIX}${LEADING[leading] ?? ""}${VOWELS[vowel] ?? ""}${TRAILING[trailing] ?? ""}`;
};

export const hexOf = (codePoint: number) =>
  codePoint.toString(16).toUpperCase().padStart(4, "0");

export const ruleName = (rule: NameRule, codePoint: number) =>
  `${rule.prefix}${hexOf(codePoint)}`;

export const HANGUL_RANGE = {
  first: HANGUL_FIRST,
  last: HANGUL_LAST,
  prefix: HANGUL_PREFIX,
} as const;
