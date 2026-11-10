/**
 * A line of text per writing system a face covers. Scripts with words on file
 * are set in real words; any other script is shown by its own characters, and
 * the line says so. Adding a script here is adding a row of data.
 */
import type { TextDirection } from "~/typeface/reading";
import { categoryOf } from "~/unicode/characters";
import type { ScopeCoverage } from "~/unicode/coverage";
import { charactersIn } from "~/unicode/scope";
import { findScript } from "~/unicode/scripts";

interface SampleWords {
  /** BCP 47, so the browser picks the language's own forms. */
  readonly language: string;
  readonly text: string;
}

/** Real words, keyed by ISO 15924 script code. */
const WORDS: Readonly<Record<string, SampleWords>> = {
  Arab: { language: "ar", text: "الحروف تحمل صوت الصفحة" },
  Armn: { language: "hy", text: "Տառ" },
  Beng: { language: "bn", text: "অক্ষর" },
  Cyrl: { language: "ru", text: "Буквы несут голос страницы" },
  Deva: { language: "hi", text: "अक्षर पन्ने की आवाज़ हैं" },
  Ethi: { language: "am", text: "ፊደል" },
  Geor: { language: "ka", text: "დამწერლობა" },
  Grek: { language: "el", text: "Τα γράμματα φέρουν τη φωνή της σελίδας" },
  Gujr: { language: "gu", text: "અક્ષર" },
  Guru: { language: "pa", text: "ਅੱਖਰ" },
  Hang: { language: "ko", text: "글자" },
  Hani: { language: "zh", text: "文字" },
  Hebr: { language: "he", text: "האותיות נושאות את קול הדף" },
  Hira: { language: "ja", text: "もじ" },
  Kana: { language: "ja", text: "モジ" },
  Khmr: { language: "km", text: "អក្សរ" },
  Knda: { language: "kn", text: "ಅಕ್ಷರ" },
  Laoo: { language: "lo", text: "ຕົວອັກສອນ" },
  Latn: { language: "en", text: "Letters carry the voice of a page" },
  Mlym: { language: "ml", text: "അക്ഷരം" },
  Mymr: { language: "my", text: "စာလုံး" },
  Orya: { language: "or", text: "ଅକ୍ଷର" },
  Sinh: { language: "si", text: "අකුර" },
  Taml: { language: "ta", text: "எழுத்து" },
  Telu: { language: "te", text: "అక్షరం" },
  Thai: { language: "th", text: "ตัวอักษร" },
  Tibt: { language: "bo", text: "ཡི་གེ" },
};

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
  return (letters.length > 0 ? letters : covered)
    .slice(0, SHOWN_CHARACTERS)
    .map((codePoint) => String.fromCodePoint(codePoint))
    .join(" ");
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
    const words = WORDS[script];
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
