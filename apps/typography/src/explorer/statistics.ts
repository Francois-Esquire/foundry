/**
 * Coverage in numbers: the face as a whole, and the languages whose required
 * characters it holds. Holding the characters is necessary for a language,
 * not sufficient: shaping still has to be proved in text.
 */
import type { CharacterStatus, FaceClassification } from "~/unicode/coverage";
import { type Language, languageSupport } from "~/unicode/languages";
import { findScript } from "~/unicode/scripts";

export interface FaceTotals {
  readonly counts: Readonly<Record<CharacterStatus, number>>;
  /** Characters the face can set: source, edited and added. */
  readonly covered: number;
}

/** Counts every character the face knows about by its status. */
export const faceTotals = (face: FaceClassification): FaceTotals => {
  const counts: Record<CharacterStatus, number> = {
    added: 0,
    candidate: 0,
    edited: 0,
    missing: 0,
    source: 0,
  };
  for (const codePoint of face.characters) {
    counts[face.classify(codePoint)] += 1;
  }
  return { counts, covered: counts.source + counts.edited + counts.added };
};

interface ScriptLanguages {
  /** English names of the languages, in alphabetical order. */
  readonly languages: readonly string[];
  /** The script's name, for example Latin. */
  readonly script: string;
}

export interface LanguageCoverage {
  readonly byScript: readonly ScriptLanguages[];
  /** How many languages have all their required characters in the face. */
  readonly complete: number;
  /** How many languages have character data at all. */
  readonly known: number;
}

/**
 * The languages whose required characters are all in the face, grouped by
 * script, the script with the most languages first.
 */
export const languageCoverage = (
  languages: readonly Language[],
  has: (codePoint: number) => boolean
): LanguageCoverage => {
  const known = languages.filter((language) => language.required.length > 0);
  const byScript = new Map<string, string[]>();
  for (const language of known) {
    if (languageSupport(language, has).supported) {
      const names = byScript.get(language.script) ?? [];
      names.push(language.name);
      byScript.set(language.script, names);
    }
  }
  const groups = [...byScript.entries()]
    .map(([code, names]) => ({
      languages: names.sort((a, b) => a.localeCompare(b, "en")),
      script: findScript(code)?.name ?? code,
    }))
    .sort(
      (a, b) =>
        b.languages.length - a.languages.length ||
        a.script.localeCompare(b.script, "en")
    );
  return {
    byScript: groups,
    complete: groups.reduce((sum, group) => sum + group.languages.length, 0),
    known: known.length,
  };
};
