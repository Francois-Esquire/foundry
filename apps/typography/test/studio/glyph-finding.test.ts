import { describe, expect, it } from "vitest";
import {
  findGlyphs,
  parseGlyphAddress,
  spokenName,
  startingGlyph,
} from "~/studio/glyph-finding";
import {
  addedGlyph,
  glyphRefKey as glyphAddress,
  sourceGlyph,
} from "~/typeface/changes";
import type { GlyphEntry } from "~/typeface/glyphs";

const entry = (
  glyphId: number,
  name: string,
  characters: readonly number[] = []
): GlyphEntry => ({
  characters,
  edited: false,
  name,
  ref: sourceGlyph(glyphId),
});

const ENTRIES: readonly GlyphEntry[] = [
  entry(0, ".notdef"),
  entry(1, "a", [0x61]),
  entry(2, "ampersand", [0x26]),
  entry(3, "a.sc"),
  entry(4, "f_i"),
  entry(5, "ka-deva", [0x9_15]),
  entry(6, "omega", [0x3_c9, 0x21_26]),
  {
    characters: [0xe0_00],
    edited: true,
    name: "triangle",
    provenance: { origin: "manual" },
    ref: addedGlyph("tri"),
  },
];

const names = (query: string, named: readonly number[] = []) =>
  findGlyphs(ENTRIES, query, named).map((found) => found.name);

describe("finding a glyph", () => {
  it("returns every glyph for an empty query", () => {
    expect(findGlyphs(ENTRIES, "  ")).toBe(ENTRIES);
  });

  it("finds the glyph of a typed character first, then names that hold it", () => {
    expect(names("a")).toEqual([
      "a",
      "ampersand",
      "a.sc",
      "ka-deva",
      "omega",
      "triangle",
    ]);
    expect(names("क")).toEqual(["ka-deva"]);
  });

  it("finds a character written as a code point", () => {
    expect(names("U+0915")).toEqual(["ka-deva"]);
    expect(names("u+26")).toEqual(["ampersand"]);
    expect(names("2126")).toEqual(["omega"]);
  });

  it("finds a glyph by its id", () => {
    expect(names("#4")).toEqual(["f_i"]);
    expect(names("gid 3")).toEqual(["a.sc"]);
  });

  it("finds glyphs with no character by name", () => {
    expect(names("f_i")).toEqual(["f_i"]);
    expect(names(".sc")).toEqual(["a.sc"]);
    expect(names("notdef")).toEqual([".notdef"]);
  });

  it("puts the exact name before names that start with or contain the text", () => {
    expect(names("am")).toEqual(["ampersand"]);
    expect(names("omega")).toEqual(["omega"]);
    expect(names("A.SC")).toEqual(["a.sc"]);
  });

  it("finds glyphs through characters whose Unicode names match, best first", () => {
    expect(names("letter ka", [0x9_15, 0x3_c9])).toEqual(["ka-deva", "omega"]);
    expect(names("ohm", [0x21_26])).toEqual(["omega"]);
  });

  it("finds glyphs the project added", () => {
    expect(names("tri")).toEqual(["triangle"]);
    expect(names("U+E000")).toEqual(["triangle"]);
  });

  it("finds nothing for text that matches nothing", () => {
    expect(names("zzz")).toEqual([]);
  });

  it("writes a glyph into an address and reads it back", () => {
    for (const ref of [sourceGlyph(68), addedGlyph("run-7:ka")]) {
      expect(parseGlyphAddress(glyphAddress(ref))).toEqual(ref);
    }
    expect(parseGlyphAddress("nonsense")).toBeUndefined();
    expect(parseGlyphAddress("s:abc")).toBeUndefined();
  });

  it("opens a face on its first letter", () => {
    expect(startingGlyph(ENTRIES)?.name).toBe("a");
    expect(
      startingGlyph([entry(0, ".notdef"), entry(1, "one", [0x31])])?.name
    ).toBe("one");
    expect(startingGlyph([entry(0, ".notdef")])?.name).toBe(".notdef");
    expect(startingGlyph([])).toBeUndefined();
  });

  it("calls a glyph by its character, or by its name when it has none that prints", () => {
    expect(spokenName(entry(45, "gid45", [0x61]))).toBe("a");
    expect(spokenName(entry(4, "f_i"))).toBe("f_i");
    expect(spokenName(entry(2, "space", [0x20]))).toBe("space");
  });
});
