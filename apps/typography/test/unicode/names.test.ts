import { describe, expect, it } from "vitest";
import { characterName } from "~/unicode/names";

describe("character names", () => {
  it.each([
    [0x41, "LATIN CAPITAL LETTER A"],
    [0xe1, "LATIN SMALL LETTER A WITH ACUTE"],
    [0x3_a9, "GREEK CAPITAL LETTER OMEGA"],
    [0x4_2f, "CYRILLIC CAPITAL LETTER YA"],
    [0x6_28, "ARABIC LETTER BEH"],
    [0x5_d0, "HEBREW LETTER ALEF"],
    [0x9_15, "DEVANAGARI LETTER KA"],
    [0x9_4d, "DEVANAGARI SIGN VIRAMA"],
    [0x20_ac, "EURO SIGN"],
    [0x1_f6_00, "GRINNING FACE"],
    [0xe_01_ef, "VARIATION SELECTOR-256"],
    [0x1_88_00, "TANGUT COMPONENT-001"],
  ])("names U+%s %s", async (codePoint, name) => {
    expect(await characterName(codePoint)).toBe(name);
  });

  it.each([
    [0x34_00, "CJK UNIFIED IDEOGRAPH-3400"],
    [0x4e_00, "CJK UNIFIED IDEOGRAPH-4E00"],
    [0x9f_ff, "CJK UNIFIED IDEOGRAPH-9FFF"],
    [0x2_00_00, "CJK UNIFIED IDEOGRAPH-20000"],
    [0x3_23_af, "CJK UNIFIED IDEOGRAPH-323AF"],
    [0xf9_00, "CJK COMPATIBILITY IDEOGRAPH-F900"],
    [0x1_70_00, "TANGUT IDEOGRAPH-17000"],
    [0x1_8b_00, "KHITAN SMALL SCRIPT CHARACTER-18B00"],
    [0x1_b1_70, "NUSHU CHARACTER-1B170"],
    [0x1_34_60, "EGYPTIAN HIEROGLYPH-13460"],
  ])("derives U+%s %s by rule", async (codePoint, name) => {
    expect(await characterName(codePoint)).toBe(name);
  });

  it.each([
    [0xac_00, "HANGUL SYLLABLE GA"],
    [0xac_01, "HANGUL SYLLABLE GAG"],
    [0xd5_5c, "HANGUL SYLLABLE HAN"],
    [0xae_00, "HANGUL SYLLABLE GEUL"],
    [0xc5_44, "HANGUL SYLLABLE A"],
    [0xd7_a3, "HANGUL SYLLABLE HIH"],
  ])("spells Hangul syllable U+%s as %s", async (codePoint, name) => {
    expect(await characterName(codePoint)).toBe(name);
  });

  it("gives no name where Unicode has none", async () => {
    for (const codePoint of [0x0, 0xa, 0x3_78, 0xd8_00, 0xe0_00, 0x10_ff_ff]) {
      expect(await characterName(codePoint)).toBeUndefined();
    }
    expect(await characterName(-1)).toBeUndefined();
    expect(await characterName(0xd7_a4)).toBeUndefined();
    expect(await characterName(0x9f_ff + 1)).not.toContain("CJK");
  });
});
