import { describe, expect, it } from "vitest";
import { blockOf, blocks, findBlock } from "~/unicode/blocks";
import {
  categoryName,
  categoryOf,
  isAssigned,
  isCombiningMark,
  scriptOf,
} from "~/unicode/characters";
import { formatCodePoint, parseCodePoint } from "~/unicode/code-point";
import { describeCharacter } from "~/unicode/identity";
import {
  blockSections,
  charactersIn,
  scopeName,
  scopeOf,
} from "~/unicode/scope";
import {
  featuredScripts,
  findScript,
  scripts,
  sharedGroups,
} from "~/unicode/scripts";

const cp = (symbol: string) => symbol.codePointAt(0) ?? 0;

describe("character properties in the featured scripts", () => {
  it.each([
    ["A", "Latn", "Lu", "Basic Latin"],
    ["é", "Latn", "Ll", "Latin-1 Supplement"],
    ["ǅ", "Latn", "Lt", "Latin Extended-B"],
    ["Ω", "Grek", "Lu", "Greek and Coptic"],
    ["ά", "Grek", "Ll", "Greek and Coptic"],
    ["ἆ", "Grek", "Ll", "Greek Extended"],
    ["Я", "Cyrl", "Lu", "Cyrillic"],
    ["ӂ", "Cyrl", "Ll", "Cyrillic"],
    ["ب", "Arab", "Lo", "Arabic"],
    ["٣", "Arab", "Nd", "Arabic"],
    ["ﷺ", "Arab", "Lo", "Arabic Presentation Forms-A"],
    ["א", "Hebr", "Lo", "Hebrew"],
    ["ָ", "Hebr", "Mn", "Hebrew"],
    ["क", "Deva", "Lo", "Devanagari"],
    ["ा", "Deva", "Mc", "Devanagari"],
    ["्", "Deva", "Mn", "Devanagari"],
    ["५", "Deva", "Nd", "Devanagari"],
  ])("%s is %s, %s, in %s", (symbol, script, category, block) => {
    expect(scriptOf(cp(symbol))).toBe(script);
    expect(categoryOf(cp(symbol))).toBe(category);
    expect(blockOf(cp(symbol))?.name).toBe(block);
    expect(isAssigned(cp(symbol))).toBe(true);
  });

  it("gives Common and Inherited their ISO 15924 codes", () => {
    expect(scriptOf(cp("1"))).toBe("Zyyy");
    expect(scriptOf(cp("।"))).toBe("Zyyy");
    expect(scriptOf(0x3_01)).toBe("Zinh");
    expect(scriptOf(0x20_0d)).toBe("Zinh");
  });

  it("knows combining marks", () => {
    expect(isCombiningMark(0x3_01)).toBe(true);
    expect(isCombiningMark(cp("ा"))).toBe(true);
    expect(isCombiningMark(0x20_dd)).toBe(true);
    expect(isCombiningMark(cp("a"))).toBe(false);
    expect(isCombiningMark(0x20_0d)).toBe(false);
  });

  it("separates assigned from unassigned", () => {
    expect(isAssigned(0x3_78)).toBe(false);
    expect(categoryOf(0x3_78)).toBe("Cn");
    expect(scriptOf(0x3_78)).toBe("Zzzz");
    expect(isAssigned(0xe0_00)).toBe(true);
    expect(categoryOf(0xe0_00)).toBe("Co");
    expect(categoryOf(0xd8_00)).toBe("Cs");
    expect(categoryOf(0x10_ff_ff)).toBe("Cn");
  });

  it("answers for values that are not code points", () => {
    for (const value of [-1, 0x11_00_00, 1.5, Number.NaN]) {
      expect(isAssigned(value)).toBe(false);
      expect(scriptOf(value)).toBe("Zzzz");
      expect(blockOf(value)).toBeUndefined();
    }
  });

  it("names general categories", () => {
    expect(categoryName("Lo")).toBe("Other Letter");
    expect(categoryName("Mn")).toBe("Nonspacing Mark");
  });
});

describe("scripts", () => {
  it("features the six first writing systems, in order", () => {
    expect(featuredScripts().map((script) => script.name)).toEqual([
      "Latin",
      "Greek",
      "Cyrillic",
      "Arabic",
      "Hebrew",
      "Devanagari",
    ]);
    expect(
      scripts()
        .slice(0, 6)
        .map((script) => script.code)
    ).toEqual(["Latn", "Grek", "Cyrl", "Arab", "Hebr", "Deva"]);
  });

  it("lists the remaining scripts by name", () => {
    const rest = scripts()
      .slice(6)
      .map((script) => script.name);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, "en")));
    expect(rest).toContain("Tai Yo");
    expect(rest).not.toContain("Common");
    expect(rest).not.toContain("Inherited");
  });

  it("knows which scripts read right to left", () => {
    const rightToLeft = (code: string) => findScript(code)?.direction;
    for (const code of ["Arab", "Hebr", "Syrc", "Thaa", "Nkoo", "Adlm"]) {
      expect(rightToLeft(code)).toBe("rtl");
    }
    for (const code of ["Latn", "Grek", "Cyrl", "Deva", "Hani", "Mong"]) {
      expect(rightToLeft(code)).toBe("ltr");
    }
  });

  it("reaches every script the same way", () => {
    for (const script of scripts()) {
      const characters = charactersIn({ code: script.code, kind: "script" });
      expect(characters).toHaveLength(script.characterCount);
      expect(scriptOf(characters[0] ?? -1)).toBe(script.code);
      expect(scriptOf(characters.at(-1) ?? -1)).toBe(script.code);
    }
    expect(charactersIn({ code: "Xxxx", kind: "script" })).toHaveLength(0);
    expect(findScript("Zyyy")).toBeUndefined();
  });

  it("splits Common and Inherited into shared groups", () => {
    const groupOf = (codePoint: number) => {
      const scope = scopeOf(codePoint);
      return scope?.kind === "shared" ? scope.group : undefined;
    };
    expect(groupOf(cp("7"))).toBe("digits");
    expect(groupOf(cp("½"))).toBe("digits");
    expect(groupOf(cp("!"))).toBe("punctuation");
    expect(groupOf(cp("।"))).toBe("punctuation");
    expect(groupOf(cp("€"))).toBe("symbols");
    expect(groupOf(cp("+"))).toBe("symbols");
    expect(groupOf(0x3_01)).toBe("marks");
    expect(groupOf(cp("ℝ"))).toBe("letters");
    expect(groupOf(cp(" "))).toBe("controls");
    expect(groupOf(0x20_0d)).toBe("controls");
    expect(scopeOf(cp("क"))).toEqual({ code: "Deva", kind: "script" });
    expect(scopeOf(0x3_78)).toBeUndefined();
    expect(scopeOf(0xe0_00)).toBeUndefined();
  });

  it("puts every assigned scripted character in exactly one scope", () => {
    const inScripts = scripts().reduce(
      (sum, script) => sum + script.characterCount,
      0
    );
    const inGroups = sharedGroups().reduce(
      (sum, group) => sum + group.characterCount,
      0
    );
    let withScript = 0;
    for (let codePoint = 0; codePoint <= 0x10_ff_ff; codePoint += 1) {
      if (scriptOf(codePoint) !== "Zzzz") {
        withScript += 1;
      }
    }
    expect(inScripts + inGroups).toBe(withScript);
    for (const group of sharedGroups()) {
      const scope = { group: group.id, kind: "shared" } as const;
      expect(charactersIn(scope)).toHaveLength(group.characterCount);
      expect(scopeName(scope)).toBe(group.name);
    }
  });
});

describe("blocks", () => {
  it("names blocks as the Unicode charts do", () => {
    for (const name of [
      "Basic Latin",
      "Latin-1 Supplement",
      "Latin Extended-A",
      "Greek and Coptic",
      "Cyrillic Extended-C",
      "Arabic Presentation Forms-B",
      "Devanagari Extended-A",
      "Phags-pa",
      "NKo",
      "CJK Unified Ideographs Extension A",
      "Combining Diacritical Marks for Symbols",
      "Miscellaneous Mathematical Symbols-A",
      "Supplemental Arrows-C",
      "Supplementary Private Use Area-B",
      "Symbols and Pictographs Extended-A",
    ]) {
      expect(findBlock(name)?.name).toBe(name);
    }
  });

  it("gives ranges in code point order without overlap", () => {
    const all = blocks();
    expect(findBlock("Devanagari")).toEqual({
      first: 0x9_00,
      last: 0x9_7f,
      name: "Devanagari",
    });
    for (let index = 1; index < all.length; index += 1) {
      expect(all[index]?.first).toBeGreaterThan(all[index - 1]?.last ?? 0);
    }
  });

  it("finds no block where none is defined", () => {
    expect(blockOf(0x2f_e0)).toBeUndefined();
    expect(blockOf(0x8_70)?.name).toBe("Arabic Extended-B");
  });

  it("gives a block's assigned characters", () => {
    expect(charactersIn({ kind: "block", name: "Basic Latin" })).toHaveLength(
      128
    );
    // U+0378, U+0379 and others in Greek and Coptic are unassigned.
    const greek = charactersIn({ kind: "block", name: "Greek and Coptic" });
    expect(greek).toHaveLength(135);
    expect(greek).not.toContain(0x3_78);
    expect(charactersIn({ kind: "block", name: "Nowhere" })).toHaveLength(0);
  });

  it("sections a script by block", () => {
    const sections = blockSections({ code: "Latn", kind: "script" });
    expect(sections.slice(0, 4).map((section) => section.block?.name)).toEqual([
      "Basic Latin",
      "Latin-1 Supplement",
      "Latin Extended-A",
      "Latin Extended-B",
    ]);
    expect(sections[0]?.characters).toHaveLength(52);
    expect(
      sections.reduce((sum, section) => sum + section.characters.length, 0)
    ).toBe(findScript("Latn")?.characterCount);
    expect(
      blockSections({ code: "Deva", kind: "script" }).map(
        (section) => section.block?.name
      )
    ).toEqual(["Devanagari", "Devanagari Extended", "Devanagari Extended-A"]);
  });

  it("sections an explicit list, sorted and distinct", () => {
    const scope = {
      codePoints: [0x9_15, 0x41, 0x42, 0x41, -4, 0x11_00_00],
      kind: "characters",
    } as const;
    expect([...charactersIn(scope)]).toEqual([0x41, 0x42, 0x9_15]);
    const sections = blockSections(scope);
    expect(sections.map((section) => section.block?.name)).toEqual([
      "Basic Latin",
      "Devanagari",
    ]);
    expect(sections.map((section) => section.characters.length)).toEqual([
      2, 1,
    ]);
  });
});

describe("code point notation", () => {
  it("formats with at least four digits", () => {
    expect(formatCodePoint(0x41)).toBe("U+0041");
    expect(formatCodePoint(0x9_15)).toBe("U+0915");
    expect(formatCodePoint(0x1_f6_00)).toBe("U+1F600");
    expect(formatCodePoint(0x10_ff_ff)).toBe("U+10FFFF");
  });

  it("parses the forms people type", () => {
    for (const text of ["U+0915", "u+915", "0915", "0x915", " U+0915 "]) {
      expect(parseCodePoint(text)).toBe(0x9_15);
    }
    expect(parseCodePoint("U+10FFFF")).toBe(0x10_ff_ff);
  });

  it("rejects what is not a code point", () => {
    for (const text of ["", "U+", "U+110000", "U+12345678", "ka", "U+09G5"]) {
      expect(parseCodePoint(text)).toBeUndefined();
    }
  });
});

describe("character identity", () => {
  it("describes a letter", async () => {
    expect(await describeCharacter(0x9_15)).toEqual({
      assigned: true,
      block: { first: 0x9_00, last: 0x9_7f, name: "Devanagari" },
      category: "Lo",
      categoryName: "Other Letter",
      codePoint: 0x9_15,
      combining: false,
      label: "U+0915",
      name: "DEVANAGARI LETTER KA",
      script: "Deva",
    });
  });

  it("describes a combining mark and an unassigned code point", async () => {
    const acute = await describeCharacter(0x3_01);
    expect(acute.combining).toBe(true);
    expect(acute.name).toBe("COMBINING ACUTE ACCENT");
    expect(acute.script).toBe("Zinh");
    const unassigned = await describeCharacter(0x3_78);
    expect(unassigned.assigned).toBe(false);
    expect(unassigned.name).toBeUndefined();
    expect(unassigned.block?.name).toBe("Greek and Coptic");
  });
});
