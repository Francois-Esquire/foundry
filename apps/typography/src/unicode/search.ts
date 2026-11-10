/**
 * Finds characters from free text: the characters themselves, code point
 * notation and ranges, or words from their names.
 */
import {
  HANGUL_RANGE,
  hangulSyllableName,
  type NameRule,
} from "./algorithmic-names";
import { isAssigned, isCodePoint } from "./characters";
import { listedNames, nameRules } from "./names";

export interface SearchOptions {
  /** The most code points to return. 200 when absent. */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 200;
const IDENTIFIER =
  /^(u\+|0x)?([0-9a-f]{1,6})(?:(?:-|–|\.\.)(?:u\+|0x)?([0-9a-f]{1,6}))?$/i;
const SEPARATORS = /[\s,;]+/;
const WORD_BREAKS = /[\s-]+/;
const NAME_WORD = /^[A-Z0-9]+$/;
const HEX_WORD = /^[0-9A-F]{4,6}$/;
const DIGIT = /\d/;
const WHITESPACE = /\s/u;

interface Identified {
  readonly codePoints: number[];
  /** Written with U+ or as a range, so it cannot be a word or literal text. */
  readonly explicit: boolean;
  /** Contains a digit, so it is unlikely to be a word such as "face". */
  readonly numeric: boolean;
}

const assignedBetween = (first: number, last: number, limit: number) => {
  const codePoints: number[] = [];
  for (
    let codePoint = first;
    codePoint <= last && codePoints.length < limit;
    codePoint += 1
  ) {
    if (isAssigned(codePoint)) {
      codePoints.push(codePoint);
    }
  }
  return codePoints;
};

const identify = (token: string, limit: number): Identified | undefined => {
  const match = IDENTIFIER.exec(token);
  if (!match) {
    return;
  }
  const [, prefix, firstDigits = "", lastDigits] = match;
  const first = Number.parseInt(firstDigits, 16);
  const last = lastDigits ? Number.parseInt(lastDigits, 16) : first;
  if (!(isCodePoint(first) && isCodePoint(last)) || last < first) {
    return;
  }
  const explicit = Boolean(prefix) || lastDigits !== undefined;
  return {
    // A code point asked for by name is returned even when it is unassigned.
    codePoints:
      explicit && first === last
        ? [first]
        : assignedBetween(first, last, limit),
    explicit,
    numeric: DIGIT.test(token),
  };
};

/** Reads the whole query as code point notation, or gives up. */
const identifyAll = (text: string, limit: number): Identified | undefined => {
  const parts = text.split(SEPARATORS).map((token) => identify(token, limit));
  const identified = parts.filter((part) => part !== undefined);
  // A lone hex digit is the character itself, not U+000A.
  if (identified.length !== parts.length || text.length === 1) {
    return;
  }
  return {
    codePoints: identified.flatMap((part) => part.codePoints),
    explicit: identified.some((part) => part.explicit),
    numeric: identified.some((part) => part.numeric),
  };
};

interface Searchable {
  readonly codePoint: number;
  /** The name with hyphens as spaces and a space at each end. */
  readonly padded: string;
}

let searchable: Promise<readonly Searchable[]> | undefined;

const pad = (name: string) => ` ${name.replaceAll("-", " ")} `;

const loadSearchable = (): Promise<readonly Searchable[]> => {
  searchable ??= (async () => {
    const entries = (await listedNames()).map(
      ([codePoint, name]): Searchable => ({ codePoint, padded: pad(name) })
    );
    for (
      let codePoint = HANGUL_RANGE.first;
      codePoint <= HANGUL_RANGE.last;
      codePoint += 1
    ) {
      entries.push({ codePoint, padded: pad(hangulSyllableName(codePoint)) });
    }
    return entries;
  })();
  return searchable;
};

/** How many words match whole, or undefined when a word does not match at all. */
const wholeWordMatches = (padded: string, words: readonly string[]) => {
  let whole = 0;
  for (const word of words) {
    if (padded.includes(` ${word} `)) {
      whole += 1;
    } else if (!padded.includes(` ${word}`)) {
      return;
    }
  }
  return whole;
};

interface RuleMatches {
  /** The one character a word names by its hex digits. */
  readonly exact: number[];
  /** The first characters of a range whose prefix holds every word. */
  readonly leading: number[];
}

/** Characters whose rule-made name matches: CJK UNIFIED IDEOGRAPH-4E00. */
const matchRule = (
  rule: NameRule,
  words: readonly string[],
  limit: number
): RuleMatches => {
  const padded = pad(rule.prefix);
  const unmatched = words.filter((word) => !padded.includes(` ${word}`));
  if (unmatched.length === 0) {
    const length = Math.min(limit, rule.last - rule.first + 1);
    return {
      exact: [],
      leading: Array.from({ length }, (_, offset) => rule.first + offset),
    };
  }
  const [digits = ""] = unmatched;
  const codePoint = HEX_WORD.test(digits) ? Number.parseInt(digits, 16) : -1;
  // The hex digits alone are notation, not a name: "face" is not U+FACE first.
  const named =
    words.length > 1 &&
    unmatched.length === 1 &&
    codePoint >= rule.first &&
    codePoint <= rule.last;
  return { exact: named ? [codePoint] : [], leading: [] };
};

const searchNames = async (text: string, limit: number): Promise<number[]> => {
  const words = text.toUpperCase().split(WORD_BREAKS).filter(Boolean);
  if (words.length === 0 || !words.every((word) => NAME_WORD.test(word))) {
    return [];
  }
  const matches: { codePoint: number; length: number; whole: number }[] = [];
  for (const { codePoint, padded } of await loadSearchable()) {
    const whole = wholeWordMatches(padded, words);
    if (whole !== undefined) {
      matches.push({ codePoint, length: padded.length, whole });
    }
  }
  // Whole-word matches first, then the shortest name: the plainest character.
  matches.sort(
    (a, b) =>
      b.whole - a.whole || a.length - b.length || a.codePoint - b.codePoint
  );
  const byRule = nameRules().map((rule) => matchRule(rule, words, limit));
  return [
    ...byRule.flatMap((rule) => rule.exact),
    ...matches.map((match) => match.codePoint),
    ...byRule.flatMap((rule) => rule.leading),
  ];
};

const literalCharacters = (text: string) =>
  [...text]
    .filter((symbol) => !WHITESPACE.test(symbol))
    .map((symbol) => symbol.codePointAt(0) ?? 0);

/**
 * Searches characters by free text and returns code points, best first.
 *
 * - Characters typed or pasted match themselves: "é", "कख".
 * - Code point notation matches that character, assigned or not: "U+0915",
 *   "0915", "u+915". A range gives its assigned characters: "U+0900-097F".
 * - Words match character names, every word required, whole or as the start
 *   of a word: "devanagari ka", "small a with acute".
 *
 * A query that reads more than one way, such as "face", returns each reading:
 * names first, then U+FACE, then the letters.
 */
export const searchCharacters = async (
  query: string,
  options: SearchOptions = {}
): Promise<number[]> => {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const text = query.trim();
  if (text === "" || limit <= 0) {
    return [];
  }
  const identified = identifyAll(text, limit);
  if (identified?.explicit) {
    return [...new Set(identified.codePoints)].slice(0, limit);
  }
  const literal = literalCharacters(text);
  // Pasted text is plainly meant as itself; an ASCII word is more likely a name.
  const literalFirst =
    literal.length === 1 || literal.some((codePoint) => codePoint > 0x7f);
  const notation = identified?.codePoints ?? [];
  const names = await searchNames(text, limit);
  const ranked = [
    ...(literalFirst ? literal : []),
    ...(identified?.numeric ? notation : []),
    ...names,
    ...notation,
    ...literal,
  ];
  return [...new Set(ranked)].slice(0, limit);
};
