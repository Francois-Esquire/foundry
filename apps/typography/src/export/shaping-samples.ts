/**
 * Texts that exercise the shaping a derived font has to keep, one set per
 * script the font holds. Scripts with texts on file get words chosen for
 * their ligatures, joining forms, conjuncts and marks. Any other script gets
 * a line of its own kept letters, which proves less, and the sample says so.
 * Adding a script here is adding a row of data.
 */
import type { ShapingSample } from "~/packaging/shaping-retention";
import { categoryOf, drawsNothing, scriptOf } from "~/unicode/characters";
import { firstLetters, SAMPLE_TEXT } from "~/unicode/sample-text";
import { findScript, scripts } from "~/unicode/scripts";

const GENERIC_LETTERS = 12;

export interface KeptScriptSample {
  /** True when the text is a line of the script's letters instead of words. */
  readonly generic: boolean;
  readonly sample: ShapingSample;
  /** The script's name, for example Devanagari. */
  readonly scriptName: string;
}

const isSetBy = (text: string, kept: ReadonlySet<number>) =>
  [...text].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return drawsNothing(codePoint) || kept.has(codePoint);
  });

/**
 * Sample texts for the scripts among the kept characters, in the order the
 * scripts are listed everywhere else. A text on file is used only when every
 * character of it is kept, so a small subset is tested on what it can set.
 */
export const shapingSamples = (
  characters: Iterable<number>
): KeptScriptSample[] => {
  const kept = new Set(characters);
  const lettersByScript = new Map<string, number[]>();
  for (const character of [...kept].sort((a, b) => a - b)) {
    const code = scriptOf(character);
    if (findScript(code) && categoryOf(character).startsWith("L")) {
      const letters = lettersByScript.get(code) ?? [];
      letters.push(character);
      lettersByScript.set(code, letters);
    }
  }
  return scripts().flatMap((script): KeptScriptSample[] => {
    const letters = lettersByScript.get(script.code);
    if (!letters) {
      return [];
    }
    const onFile = SAMPLE_TEXT[script.code];
    const options = {
      direction: script.direction,
      language: onFile?.shapingTexts ? onFile.language : undefined,
      script: script.code,
    };
    const texts =
      onFile?.shapingTexts?.filter((text) => isSetBy(text, kept)) ?? [];
    return texts.length > 0
      ? texts.map((text) => ({
          generic: false,
          sample: { options, text },
          scriptName: script.name,
        }))
      : [
          {
            generic: true,
            sample: {
              options,
              text: firstLetters(letters, GENERIC_LETTERS).join(""),
            },
            scriptName: script.name,
          },
        ];
  });
};
