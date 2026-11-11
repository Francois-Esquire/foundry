/**
 * Texts that exercise the shaping a derived font has to keep, one set per
 * script the font holds. Scripts with texts on file get words chosen for
 * their ligatures, joining forms, conjuncts and marks. Any other script gets
 * a line of its own kept letters, which proves less, and the sample says so.
 * Adding a script here is adding a row of data.
 */
import type { ShapingSample } from "~/packaging/shaping-retention";
import { categoryOf, drawsNothing, scriptOf } from "~/unicode/characters";
import { findScript, scripts } from "~/unicode/scripts";

interface ScriptTexts {
  /** BCP 47, so the shaper picks the language's own forms. */
  readonly language: string;
  readonly texts: readonly string[];
}

/** Keyed by ISO 15924 script code. */
const TEXTS: Readonly<Record<string, ScriptTexts>> = {
  Arab: { language: "ar", texts: ["الحروف تحمل صوت الصفحة", "لا", "بيت"] },
  Cyrl: { language: "ru", texts: ["Буквы несут голос страницы", "Гд"] },
  Deva: {
    language: "hi",
    texts: ["अक्षर पन्ने की आवाज़ हैं", "क्ष", "त्र", "कि"],
  },
  Grek: {
    language: "el",
    texts: ["Τα γράμματα φέρουν τη φωνή της σελίδας", "Άυλος"],
  },
  Hebr: { language: "he", texts: ["האותיות נושאות את קול הדף", "שָׁלוֹם"] },
  Latn: {
    language: "en",
    texts: [
      "office",
      "fi",
      "AV",
      "Waffle",
      "Letters carry the voice of a page",
    ],
  },
};

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

const genericLine = (letters: readonly number[]) =>
  letters
    .slice(0, GENERIC_LETTERS)
    .map((codePoint) => String.fromCodePoint(codePoint))
    .join("");

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
    const onFile = TEXTS[script.code];
    const options = {
      direction: script.direction,
      language: onFile?.language,
      script: script.code,
    };
    const texts = onFile?.texts.filter((text) => isSetBy(text, kept)) ?? [];
    return texts.length > 0
      ? texts.map((text) => ({
          generic: false,
          sample: { options, text },
          scriptName: script.name,
        }))
      : [
          {
            generic: true,
            sample: { options, text: genericLine(letters) },
            scriptName: script.name,
          },
        ];
  });
};
