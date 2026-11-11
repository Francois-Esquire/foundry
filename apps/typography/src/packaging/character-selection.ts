/** Turns the selectors of an export plan into the characters they name. */

import { formatCodePoint } from "~/lib/code-point";
import type { CharacterLookups, CharacterSelector } from "./export-plan";

const LAST_CODE_POINT = 0x10_ff_ff;

export interface SelectedCharacters {
  readonly characters: ReadonlySet<number>;
  /** Selectors that named nothing, described for a message. */
  readonly empty: readonly string[];
}

const isCodePoint = (value: number) =>
  Number.isInteger(value) && value >= 0 && value <= LAST_CODE_POINT;

const describe = (selector: CharacterSelector): string => {
  switch (selector.kind) {
    case "characters":
      return "the list of characters";
    case "range":
      return `the range ${formatCodePoint(selector.first)} to ${formatCodePoint(selector.last)}`;
    case "script":
      return `the script ${selector.script}`;
    case "block":
      return `the block ${selector.block}`;
    default:
      return `the language ${selector.language}`;
  }
};

function* rangeOf(first: number, last: number): Iterable<number> {
  const start = Math.max(0, Math.ceil(Math.min(first, last)));
  const end = Math.min(LAST_CODE_POINT, Math.floor(Math.max(first, last)));
  for (let character = start; character <= end; character += 1) {
    yield character;
  }
}

const charactersOf = (
  selector: CharacterSelector,
  lookups: CharacterLookups
): Iterable<number> => {
  switch (selector.kind) {
    case "characters":
      return selector.codePoints;
    case "range":
      return rangeOf(selector.first, selector.last);
    case "script":
      return lookups.charactersOfScript(selector.script);
    case "block":
      return lookups.charactersOfBlock(selector.block);
    default:
      return lookups.charactersOfLanguage(selector.language);
  }
};

/**
 * The first few of a list of characters, in writing: "U+0041, U+0042 and
 * others" when there are more than `limit`.
 */
export const listCharacters = (
  characters: readonly number[],
  limit: number
): string =>
  `${characters.slice(0, limit).map(formatCodePoint).join(", ")}${
    characters.length > limit ? " and others" : ""
  }`;

/** The union of every selector's characters. */
export const selectCharacters = (
  selectors: readonly CharacterSelector[],
  lookups: CharacterLookups
): SelectedCharacters => {
  const characters = new Set<number>();
  const empty: string[] = [];
  for (const selector of selectors) {
    const before = characters.size;
    let named = 0;
    for (const character of charactersOf(selector, lookups)) {
      if (isCodePoint(character)) {
        characters.add(character);
        named += 1;
      }
    }
    if (named === 0 && characters.size === before) {
      empty.push(describe(selector));
    }
  }
  return { characters, empty };
};
