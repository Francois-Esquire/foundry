/** Sample words and shaping texts, keyed by ISO 15924 script code. */
interface SampleWords {
  /** BCP 47, so the browser picks the language's own forms. */
  readonly language: string;
  readonly shapingTexts?: readonly string[];
  readonly text: string;
}

/** Real words, keyed by ISO 15924 script code. */
export const SAMPLE_TEXT: Readonly<Record<string, SampleWords>> & {
  readonly Latn: SampleWords;
} = {
  Arab: {
    language: "ar",
    shapingTexts: ["الحروف تحمل صوت الصفحة", "لا", "بيت"],
    text: "الحروف تحمل صوت الصفحة",
  },
  Armn: { language: "hy", text: "Տառ" },
  Beng: { language: "bn", text: "অক্ষর" },
  Cyrl: {
    language: "ru",
    shapingTexts: ["Буквы несут голос страницы", "Гд"],
    text: "Буквы несут голос страницы",
  },
  Deva: {
    language: "hi",
    shapingTexts: ["अक्षर पन्ने की आवाज़ हैं", "क्ष", "त्र", "कि"],
    text: "अक्षर पन्ने की आवाज़ हैं",
  },
  Ethi: { language: "am", text: "ፊደል" },
  Geor: { language: "ka", text: "დამწერლობა" },
  Grek: {
    language: "el",
    shapingTexts: ["Τα γράμματα φέρουν τη φωνή της σελίδας", "Άυλος"],
    text: "Τα γράμματα φέρουν τη φωνή της σελίδας",
  },
  Gujr: { language: "gu", text: "અક્ષર" },
  Guru: { language: "pa", text: "ਅੱਖਰ" },
  Hang: { language: "ko", text: "글자" },
  Hani: { language: "zh", text: "文字" },
  Hebr: {
    language: "he",
    shapingTexts: ["האותיות נושאות את קול הדף", "שָׁלוֹם"],
    text: "האותיות נושאות את קול הדף",
  },
  Hira: { language: "ja", text: "もじ" },
  Kana: { language: "ja", text: "モジ" },
  Khmr: { language: "km", text: "អក្សរ" },
  Knda: { language: "kn", text: "ಅಕ್ಷರ" },
  Laoo: { language: "lo", text: "ຕົວອັກສອນ" },
  Latn: {
    language: "en",
    shapingTexts: [
      "office",
      "fi",
      "AV",
      "Waffle",
      "Letters carry the voice of a page",
    ],
    text: "Letters carry the voice of a page",
  },
  Mlym: { language: "ml", text: "അക്ഷരം" },
  Mymr: { language: "my", text: "စာလုံး" },
  Orya: { language: "or", text: "ଅକ୍ଷର" },
  Sinh: { language: "si", text: "අකුර" },
  Taml: { language: "ta", text: "எழுத்து" },
  Telu: { language: "te", text: "అక్షరం" },
  Thai: { language: "th", text: "ตัวอักษร" },
  Tibt: { language: "bo", text: "ཡི་གེ" },
};
/** The first characters of an ordered sequence, kept as individual strings. */
export const firstLetters = (
  characters: Iterable<number>,
  limit: number
): string[] => {
  const letters: string[] = [];
  for (const codePoint of characters) {
    letters.push(String.fromCodePoint(codePoint));
    if (letters.length === limit) {
      break;
    }
  }
  return letters;
};
