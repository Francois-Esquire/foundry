/**
 * A line of text per writing system a face covers. Scripts with words on file
 * are set in real words; any other script is shown by its own characters, and
 * the line says so. Adding a script here is adding a row of data.
 */
import type { TextDirection } from "~/typeface/reading";
import { categoryOf } from "~/unicode/characters";
import type { ScopeCoverage } from "~/unicode/coverage";
import { firstLetters, SAMPLE_TEXT } from "~/unicode/sample-text";
import { charactersIn } from "~/unicode/scope";
import { findScript } from "~/unicode/scripts";

const SHOWN_CHARACTERS = 16;

export interface SampleLine {
  readonly direction: TextDirection;
  /** Undefined for a line of characters, which belongs to no language. */
  readonly language: string | undefined;
  /** The script's name, for example Devanagari. */
  readonly name: string;
  /** ISO 15924. */
  readonly script: string;
  readonly text: string;
  /** False when the line is the script's characters instead of words. */
  readonly words: boolean;
}

/** The first characters of a script that the face holds, letters before anything else. */
const coveredCharacters = (
  script: string,
  has: (codePoint: number) => boolean
): string => {
  const covered = [...charactersIn({ code: script, kind: "script" })].filter(
    has
  );
  const letters = covered.filter((codePoint) =>
    categoryOf(codePoint).startsWith("L")
  );
  return firstLetters(
    letters.length > 0 ? letters : covered,
    SHOWN_CHARACTERS
  ).join(" ");
};

/** One line per script the face has characters of, in the order given. */
export const sampleLines = (
  byScope: readonly ScopeCoverage[],
  has: (codePoint: number) => boolean
): SampleLine[] =>
  byScope.flatMap((row): SampleLine[] => {
    if (row.scope.kind !== "script" || row.covered === 0) {
      return [];
    }
    const script = row.scope.code;
    const words = SAMPLE_TEXT[script];
    return [
      {
        direction: findScript(script)?.direction ?? "ltr",
        language: words?.language,
        name: row.name,
        script,
        text: words?.text ?? coveredCharacters(script, has),
        words: words !== undefined,
      },
    ];
  });
