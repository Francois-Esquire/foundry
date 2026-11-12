import { scopeKey } from "~/explorer/coverage-address";
/**
 * What a face is made of, script by script: the rows of the composition list
 * and of the coverage statistics, and the level mark each row earns.
 *
 * The level counts characters only. It says nothing about shaping, so a row
 * with three dots still has to be proved in text before the script is called
 * supported.
 */
import type { CharacterStatus, ScopeCoverage } from "~/unicode/coverage";
import { type Language, languageSupport } from "~/unicode/languages";
import type { Scope } from "~/unicode/scope";
import { featuredScripts } from "~/unicode/scripts";

/** How a script stands in a face, in the terms the composition list prints. */
export type Standing =
  | { readonly kind: "candidates"; readonly count: number }
  | { readonly kind: "level"; readonly level: 1 | 2 | 3 }
  | { readonly kind: "missing" };

export interface CompositionRow extends ScopeCoverage {
  readonly standing: Standing;
}

/** What each number of dots means, for the legend beside the list. */
export const LEVEL_MEANINGS: readonly string[] = [
  "One dot: the face has some of the script's characters.",
  "Two dots: it has every required character of at least one language written in the script.",
  "Three dots: it has every character Unicode assigns to the script.",
];

const ZERO_COUNTS: Readonly<Record<CharacterStatus, number>> = {
  added: 0,
  candidate: 0,
  edited: 0,
  missing: 0,
  source: 0,
};

/** True when the face has every required character of a language in this script. */
const completesALanguage = (
  scope: Scope,
  languages: readonly Language[],
  has: (codePoint: number) => boolean
) =>
  scope.kind === "script" &&
  languages.some(
    (language) =>
      language.script === scope.code &&
      language.required.length > 0 &&
      languageSupport(language, has).supported
  );

export const standingOf = (
  coverage: ScopeCoverage,
  languages: readonly Language[],
  has: (codePoint: number) => boolean
): Standing => {
  if (coverage.covered === 0) {
    return coverage.counts.candidate > 0
      ? { count: coverage.counts.candidate, kind: "candidates" }
      : { kind: "missing" };
  }
  if (coverage.covered === coverage.total) {
    return { kind: "level", level: 3 };
  }
  return {
    kind: "level",
    level: completesALanguage(coverage.scope, languages, has) ? 2 : 1,
  };
};

const untouched = (script: {
  readonly characterCount: number;
  readonly code: string;
  readonly name: string;
}): ScopeCoverage => ({
  counts: { ...ZERO_COUNTS, missing: script.characterCount },
  covered: 0,
  name: script.name,
  percent: 0,
  scope: { code: script.code, kind: "script" },
  total: script.characterCount,
});

/**
 * The six featured scripts first, always, even at nothing. Then every other
 * script the face touches, the best covered first, then the shared groups.
 */
export const compositionRows = (
  byScope: readonly ScopeCoverage[],
  languages: readonly Language[],
  has: (codePoint: number) => boolean
): CompositionRow[] => {
  const touched = new Map(byScope.map((row) => [scopeKey(row.scope), row]));
  const featured = featuredScripts().map(
    (script) => touched.get(script.code) ?? untouched(script)
  );
  const featuredKeys = new Set(featured.map((row) => scopeKey(row.scope)));
  const others = byScope.filter(
    (row) => !featuredKeys.has(scopeKey(row.scope))
  );
  return [
    ...featured,
    ...others.filter((row) => row.scope.kind === "script"),
    ...others.filter((row) => row.scope.kind === "shared"),
  ].map((row) => ({ ...row, standing: standingOf(row, languages, has) }));
};

/**
 * The script a face is mostly about: many characters, and a large share of
 * the script. Undefined for a face that touches no script.
 */
export const leadingScript = (
  byScope: readonly ScopeCoverage[]
): Scope | undefined => {
  let leading: ScopeCoverage | undefined;
  let best = 0;
  for (const row of byScope) {
    const weight = (row.covered * row.covered) / Math.max(1, row.total);
    if (row.scope.kind === "script" && weight > best) {
      best = weight;
      leading = row;
    }
  }
  return leading?.scope;
};
