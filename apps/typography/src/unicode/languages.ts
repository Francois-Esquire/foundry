/**
 * Languages and the characters they are written with, from CLDR exemplars.
 * Loaded on demand. Having the characters is necessary for a language, not
 * sufficient: shaping still has to be verified before it is called supported.
 */
import { decodeCodePoints } from "./code-point-set";

export interface Language {
  /** Characters for loanwords and names. Never repeats a required character. */
  readonly auxiliary: Uint32Array;
  /** The English name, for example Hindi. */
  readonly name: string;
  /** Characters everyday text needs, capitals included. Ascending. */
  readonly required: Uint32Array;
  /** ISO 15924 code of the script most required characters belong to. */
  readonly script: string;
  /** BCP 47, for example hi or sr-Latn. */
  readonly tag: string;
}

let loading: Promise<readonly Language[]> | undefined;

const parse = (encoded: string): Language[] =>
  encoded.split(";").map((row) => {
    const [tag = "", name = "", script = "", required = "", auxiliary = ""] =
      row.split("|");
    return {
      auxiliary: decodeCodePoints(auxiliary),
      name,
      required: decodeCodePoints(required),
      script,
      tag,
    };
  });

/** Every language with exemplar data, ordered by tag. */
export const languages = (): Promise<readonly Language[]> => {
  loading ??= import("./data/languages").then((data) => parse(data.LANGUAGES));
  return loading;
};

export const findLanguage = async (
  tag: string
): Promise<Language | undefined> =>
  (await languages()).find((language) => language.tag === tag);

export interface LanguageSupport {
  readonly language: Language;
  readonly missingAuxiliary: number[];
  readonly missingRequired: number[];
  /** True when every required character is present. */
  readonly supported: boolean;
}

/** Which of a language's characters a face lacks. `has` says what the face holds. */
export const languageSupport = (
  language: Language,
  has: (codePoint: number) => boolean
): LanguageSupport => {
  const missingRequired = [...language.required].filter(
    (codePoint) => !has(codePoint)
  );
  return {
    language,
    missingAuxiliary: [...language.auxiliary].filter(
      (codePoint) => !has(codePoint)
    ),
    missingRequired,
    supported: missingRequired.length === 0,
  };
};

/** The languages whose required characters are all present. */
export const supportedLanguages = async (
  has: (codePoint: number) => boolean
): Promise<Language[]> =>
  (await languages()).filter(
    (language) => languageSupport(language, has).supported
  );
