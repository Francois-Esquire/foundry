import { describe, expect, it } from "vitest";
import { isAssigned } from "~/unicode/characters";
import { characterName } from "~/unicode/names";
import { searchCharacters } from "~/unicode/search";

const cp = (symbol: string) => symbol.codePointAt(0) ?? 0;

describe("searching by literal characters", () => {
  it("finds a single typed character first", async () => {
    expect((await searchCharacters("é"))[0]).toBe(0xe9);
    expect((await searchCharacters("a"))[0]).toBe(0x61);
    expect((await searchCharacters("5"))[0]).toBe(0x35);
    expect(await searchCharacters("क")).toEqual([0x9_15]);
  });

  it("finds each pasted character once, in the order typed", async () => {
    expect(await searchCharacters("कख क ग")).toEqual([0x9_15, 0x9_16, 0x9_17]);
    expect(await searchCharacters("😀→")).toEqual([0x1_f6_00, cp("→")]);
  });

  it("separates a base letter from its combining mark", async () => {
    expect(await searchCharacters("e\u0301")).toEqual([0x65, 0x3_01]);
  });

  it("still offers the letters of a word that names nothing", async () => {
    expect(await searchCharacters("qzx")).toEqual([cp("q"), cp("z"), cp("x")]);
  });
});

describe("searching by code point notation", () => {
  it.each(["U+0915", "u+915", "0915", "0x915", " U+0915 "])(
    "reads %s",
    async (query) => {
      expect((await searchCharacters(query))[0]).toBe(0x9_15);
    }
  );

  it("returns only the code point when the notation is explicit", async () => {
    expect(await searchCharacters("U+0915")).toEqual([0x9_15]);
    expect(await searchCharacters("U+1F600")).toEqual([0x1_f6_00]);
    expect(await searchCharacters("U+0915, U+0041 u+5d0")).toEqual([
      0x9_15, 0x41, 0x5_d0,
    ]);
  });

  it("returns an unassigned code point asked for explicitly", async () => {
    expect(await searchCharacters("U+0378")).toEqual([0x3_78]);
    expect(await searchCharacters("0378")).toEqual([
      cp("0"),
      cp("3"),
      cp("7"),
      cp("8"),
    ]);
  });

  it("expands a range to its assigned characters", async () => {
    const devanagari = await searchCharacters("U+0900-097F");
    expect(devanagari).toHaveLength(128);
    expect(devanagari[0]).toBe(0x9_00);
    expect(devanagari.at(-1)).toBe(0x9_7f);
    for (const query of ["0900-097F", "u+900..u+97f", "U+0900–U+097F"]) {
      expect(await searchCharacters(query)).toEqual(devanagari);
    }
    const greek = await searchCharacters("U+0370-03FF");
    expect(greek).toHaveLength(135);
    expect(greek.every(isAssigned)).toBe(true);
  });

  it("caps a large range", async () => {
    expect(await searchCharacters("U+4E00-9FFF")).toHaveLength(200);
    expect(await searchCharacters("U+0000-10FFFF", { limit: 7 })).toHaveLength(
      7
    );
  });

  it("ignores notation that is out of range or backwards", async () => {
    expect(await searchCharacters("U+110000")).not.toContain(0x11_00_00);
    expect(await searchCharacters("U+0041-0030")).not.toContain(0x41);
  });
});

describe("searching by name", () => {
  it("finds devanagari ka", async () => {
    const found = await searchCharacters("devanagari ka");
    expect(found[0]).toBe(0x9_15);
    const named = found.filter((codePoint) => codePoint > 0x7f);
    expect(named.length).toBeGreaterThan(0);
    for (const codePoint of named) {
      expect(await characterName(codePoint)).toContain("DEVANAGARI");
    }
  });

  it("finds small a with acute", async () => {
    const found = await searchCharacters("small a with acute");
    expect(found[0]).toBe(0xe1);
    expect(found).toContain(0x1_fb);
  });

  it("requires every word", async () => {
    const found = await searchCharacters("hebrew letter alef");
    expect(found[0]).toBe(0x5_d0);
    for (const codePoint of found) {
      const name = (await characterName(codePoint)) ?? "";
      if (codePoint > 0x7f) {
        expect(name).toContain("HEBREW");
        expect(name).toContain("ALEF");
      }
    }
    expect(await searchCharacters("devanagari omega")).toEqual(
      [..."devanagariomega"]
        .map(cp)
        .filter((codePoint, index, all) => all.indexOf(codePoint) === index)
    );
  });

  it("matches the start of a word, whole words first", async () => {
    const found = await searchCharacters("arab beh");
    expect(found[0]).toBe(0x6_28);
    const greek = await searchCharacters("greek omega");
    expect(greek.slice(0, 2).sort()).toEqual([0x3_a9, 0x3_c9]);
  });

  it("finds a name in each featured script", async () => {
    expect((await searchCharacters("latin capital letter a"))[0]).toBe(0x41);
    expect((await searchCharacters("greek small letter alpha"))[0]).toBe(
      0x3_b1
    );
    expect((await searchCharacters("cyrillic capital letter ya"))[0]).toBe(
      0x4_2f
    );
    expect((await searchCharacters("arabic letter beh"))[0]).toBe(0x6_28);
    expect((await searchCharacters("hebrew letter bet"))[0]).toBe(0x5_d1);
    expect((await searchCharacters("devanagari sign virama"))[0]).toBe(0x9_4d);
  });

  it("finds names made by rule", async () => {
    // U+1F229 SQUARED CJK UNIFIED IDEOGRAPH-4E00 holds the same words.
    expect(
      (await searchCharacters("cjk unified ideograph-4e00")).slice(0, 2)
    ).toEqual([0x4e_00, 0x1_f2_29]);
    expect((await searchCharacters("hangul syllable han"))[0]).toBe(0xd5_5c);
    expect((await searchCharacters("tangut ideograph"))[0]).toBe(0x1_70_00);
  });

  it("reads an ambiguous word every way: names, then notation, then letters", async () => {
    const found = await searchCharacters("face", { limit: 5000 });
    expect(await characterName(found[0] ?? 0)).toContain("FACE");
    expect(found).toContain(0x1_f6_00);
    expect(found).toContain(0xfa_ce);
    expect(found.indexOf(0xfa_ce)).toBeGreaterThan(found.indexOf(0x1_f6_00));
    expect(found.at(-1)).toBe(cp("e"));
  });
});

describe("search limits", () => {
  it("caps results at 200 unless told otherwise", async () => {
    expect(await searchCharacters("letter")).toHaveLength(200);
    expect(await searchCharacters("letter", { limit: 3 })).toHaveLength(3);
    expect(await searchCharacters("letter", { limit: 0 })).toEqual([]);
  });

  it("returns nothing for an empty query", async () => {
    expect(await searchCharacters("")).toEqual([]);
    expect(await searchCharacters("   ")).toEqual([]);
  });

  it("never repeats a code point", async () => {
    const found = await searchCharacters("a", { limit: 1000 });
    expect(new Set(found).size).toBe(found.length);
  });
});
