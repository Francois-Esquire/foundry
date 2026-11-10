/**
 * What a character selection can be made from, for the faces being exported:
 * the writing systems, blocks and languages their characters belong to. Only
 * what the faces hold is offered, so every choice keeps something.
 */
import { blockOf } from "~/unicode/blocks";
import { type Language, languageSupport } from "~/unicode/languages";
import { scopeName, scopeOf } from "~/unicode/scope";
import { type SharedGroupId, scripts, sharedGroups } from "~/unicode/scripts";

export interface SelectionOption<Value extends string = string> {
  /** How many of the faces' characters the option holds. */
  readonly count: number;
  readonly name: string;
  readonly value: Value;
}

export interface SelectionOptions {
  /** In code point order. */
  readonly blocks: readonly SelectionOption[];
  /** In the order scripts are listed everywhere else. Values are ISO 15924 codes. */
  readonly scripts: readonly SelectionOption[];
  /** Digits, punctuation and the other characters scripts share. */
  readonly sharedGroups: readonly SelectionOption<SharedGroupId>[];
}

const bump = (counts: Map<string, number>, key: string) =>
  counts.set(key, (counts.get(key) ?? 0) + 1);

export const selectionOptions = (
  characters: Iterable<number>
): SelectionOptions => {
  const byScript = new Map<string, number>();
  const byGroup = new Map<string, number>();
  const byBlock = new Map<string, { count: number; first: number }>();
  for (const character of new Set(characters)) {
    const scope = scopeOf(character);
    if (scope?.kind === "script") {
      bump(byScript, scope.code);
    } else if (scope?.kind === "shared") {
      bump(byGroup, scope.group);
    }
    const block = blockOf(character);
    if (block) {
      const entry = byBlock.get(block.name) ?? { count: 0, first: block.first };
      entry.count += 1;
      byBlock.set(block.name, entry);
    }
  }
  return {
    blocks: [...byBlock.entries()]
      .sort(([, a], [, b]) => a.first - b.first)
      .map(([name, { count }]) => ({ count, name, value: name })),
    scripts: scripts().flatMap((script) => {
      const count = byScript.get(script.code);
      return count === undefined
        ? []
        : [{ count, name: script.name, value: script.code }];
    }),
    sharedGroups: sharedGroups().flatMap((group) => {
      const count = byGroup.get(group.id);
      return count === undefined
        ? []
        : [
            {
              count,
              name: scopeName({ group: group.id, kind: "shared" }),
              value: group.id,
            },
          ];
    }),
  };
};

/**
 * The languages whose everyday characters the faces hold in full, by name.
 * Holding the characters is necessary for a language and not sufficient:
 * shaping is checked on the built font.
 */
export const languageOptions = (
  languages: readonly Language[],
  characters: Iterable<number>
): SelectionOption[] => {
  const held = new Set(characters);
  return languages
    .filter(
      (language) =>
        language.required.length > 0 &&
        languageSupport(language, (character) => held.has(character)).supported
    )
    .map((language) => ({
      count: language.required.length,
      name: language.name,
      value: language.tag,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
};

/** The options whose name or value contains the query, ignoring case. */
export const matchingOptions = (
  options: readonly SelectionOption[],
  query: string
): SelectionOption[] => {
  const needle = query.trim().toLowerCase();
  return needle === ""
    ? [...options]
    : options.filter(
        (option) =>
          option.name.toLowerCase().includes(needle) ||
          option.value.toLowerCase() === needle
      );
};

/**
 * The options with every chosen value among them. A value chosen while
 * another face was in the plan may hold none of the present faces'
 * characters; it is still listed, with a count of zero, so it can be seen
 * and taken out again.
 */
export const keepingChosen = <Value extends string>(
  options: readonly SelectionOption<Value>[],
  chosen: readonly Value[],
  nameOf: (value: Value) => string
): SelectionOption<Value>[] => {
  const offered = new Set(options.map((option) => option.value));
  return [
    ...options,
    ...chosen
      .filter((value) => !offered.has(value))
      .map((value) => ({ count: 0, name: nameOf(value), value })),
  ];
};
