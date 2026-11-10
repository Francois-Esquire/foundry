import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { scriptOf } from "~/unicode/characters";
import {
  findLanguage,
  type Language,
  languageSupport,
  languages,
  supportedLanguages,
} from "~/unicode/languages";
import { fontBytes } from "../helpers/fixtures";

const ISO_15924 = /^[A-Z][a-z]{3}$/;

const codePointsOf = (text: string) =>
  [...text].map((symbol) => symbol.codePointAt(0) ?? 0);

const language = async (tag: string): Promise<Language> => {
  const found = await findLanguage(tag);
  if (!found) {
    throw new Error(`No language ${tag}`);
  }
  return found;
};

const textOf = (codePoints: Uint32Array) => String.fromCodePoint(...codePoints);

describe("language requirements", () => {
  it("lists languages by tag with an English name and a script", async () => {
    const all = await languages();
    expect(all.length).toBeGreaterThan(90);
    const tags = all.map((entry) => entry.tag);
    expect(tags).toEqual([...tags].sort());
    expect(new Set(tags).size).toBe(tags.length);
    for (const entry of all) {
      expect(entry.name).not.toBe("");
      expect(entry.required.length).toBeGreaterThan(0);
      expect(entry.script).toMatch(ISO_15924);
    }
  });

  it.each([
    ["en", "English", "Latn"],
    ["el", "Greek", "Grek"],
    ["ru", "Russian", "Cyrl"],
    ["ar", "Arabic", "Arab"],
    ["he", "Hebrew", "Hebr"],
    ["hi", "Hindi", "Deva"],
  ])("knows %s is %s, written in %s", async (tag, name, script) => {
    const found = await language(tag);
    expect(found.name).toBe(name);
    expect(found.script).toBe(script);
  });

  it("requires the English alphabet in both cases", async () => {
    const english = await language("en");
    expect(textOf(english.required)).toBe(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    );
    expect([...english.auxiliary]).toContain(0xe9);
    expect([...english.auxiliary]).toContain(0xc9);
  });

  it("requires Greek letters with tonos and final sigma", async () => {
    const greek = await language("el");
    const required = new Set(greek.required);
    for (const codePoint of codePointsOf("αάβγδωώςΐΰΑΆΩΏΣ")) {
      expect(required.has(codePoint)).toBe(true);
    }
    expect(required.has(0x1f_00)).toBe(false);
    expect([...greek.auxiliary]).toContain(0x1f_00);
    // 36 lower case exemplars and 33 capitals: ΐ and ΰ have none, ς shares Σ.
    expect(greek.required).toHaveLength(69);
  });

  it("requires the 33 Russian letters in both cases", async () => {
    const russian = await language("ru");
    expect(russian.required).toHaveLength(66);
    expect([...russian.required]).toContain(0x4_01);
    expect([...russian.required]).toContain(0x4_51);
    // The auxiliary stressed vowels add only the combining acute.
    expect([...russian.auxiliary]).toEqual([0x3_01]);
  });

  it("requires Arabic letters and harakat", async () => {
    const arabic = await language("ar");
    const required = new Set(arabic.required);
    for (const codePoint of codePointsOf(
      "ءآأؤإئابةتثجحخدذرزسشصضطظعغفقكلمنهوىي"
    )) {
      expect(required.has(codePoint)).toBe(true);
    }
    for (let harakat = 0x6_4b; harakat <= 0x6_52; harakat += 1) {
      expect(required.has(harakat)).toBe(true);
    }
    expect(arabic.required).toHaveLength(45);
    expect([...arabic.auxiliary]).toContain(0x20_0c);
    expect([...arabic.auxiliary]).toContain(0x6_7e);
  });

  it("requires the Hebrew alphabet with final forms", async () => {
    const hebrew = await language("he");
    expect(textOf(hebrew.required)).toBe("אבגדהוזחטיךכלםמןנסעףפץצקרשת");
    expect([...hebrew.auxiliary]).toContain(0x5_b0);
  });

  it("requires Hindi vowels, consonants, matras and signs", async () => {
    const hindi = await language("hi");
    const required = new Set(hindi.required);
    for (const codePoint of codePointsOf("अआइईकखगघहािीुू्ंँःॐ़")) {
      expect(required.has(codePoint)).toBe(true);
    }
    // 5 signs, 14 vowels, 34 consonants, avagraha and 13 dependent signs.
    expect(hindi.required).toHaveLength(67);
    expect([...hindi.required].every((cp) => scriptOf(cp) === "Deva")).toBe(
      true
    );
    expect([...hindi.auxiliary]).toEqual([0x9_44, 0x20_0c, 0x20_0d]);
  });

  it("takes the code points of multi-character exemplars", async () => {
    const czech = await language("cs");
    // Czech lists the digraph ch; it adds no character beyond c and h.
    expect([...czech.required]).toContain(0x63);
    expect([...czech.required]).toContain(0x68);
    expect([...czech.required].every((cp) => cp < 0x2_50)).toBe(true);
  });

  it("drops locales that repeat their parent and keeps real variants", async () => {
    const tags = (await languages()).map((entry) => entry.tag);
    expect(tags).toContain("sr");
    expect(tags).toContain("sr-Latn");
    expect(tags).not.toContain("sr-Cyrl");
    expect(tags).not.toContain("en-GB");
    expect(tags).not.toContain("und");
    expect((await language("sr-Latn")).script).toBe("Latn");
    expect((await language("sr")).script).toBe("Cyrl");
  });
});

describe("language support of a face", () => {
  it("reports what a face lacks", async () => {
    const hindi = await language("hi");
    const has = (codePoint: number) => codePoint !== 0x9_15;
    const support = languageSupport(hindi, has);
    expect(support.supported).toBe(false);
    expect(support.missingRequired).toEqual([0x9_15]);
    expect(support.missingAuxiliary).toEqual([]);
    expect(languageSupport(hindi, () => true).supported).toBe(true);
    expect(languageSupport(hindi, () => false).missingRequired).toHaveLength(
      hindi.required.length
    );
  });

  it("finds the languages each fixture font has the characters for", async () => {
    const supportedBy = async (font: "lato" | "sofia" | "devanagari") => {
      const face = harfBuzzReader.open(fontBytes(font));
      const characters = new Set(face.characters());
      face.close();
      const supported = await supportedLanguages((cp) => characters.has(cp));
      return supported.map((entry) => entry.tag);
    };
    const lato = await supportedBy("lato");
    expect(lato).toEqual(expect.arrayContaining(["en", "de", "fr", "cs"]));
    expect(lato).not.toContain("hi");
    expect(lato).not.toContain("ar");

    const sofia = await supportedBy("sofia");
    expect(sofia).toEqual(expect.arrayContaining(["en", "el", "ru", "sr"]));
    expect(sofia).not.toContain("hi");
    expect(sofia).not.toContain("he");

    const devanagari = await supportedBy("devanagari");
    expect(devanagari).toEqual(expect.arrayContaining(["hi", "mr", "ne"]));
    expect(devanagari).not.toContain("ru");
  });
});
