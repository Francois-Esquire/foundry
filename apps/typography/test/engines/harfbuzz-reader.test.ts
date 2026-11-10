import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { outlineBounds } from "~/typeface/outline";
import { UnreadableFontError } from "~/typeface/reading";
import { fontBytes } from "../helpers/fixtures";

describe("harfBuzzReader", () => {
  it("describes a static face", () => {
    const { description } = harfBuzzReader.open(fontBytes("lato"));
    expect(description).toMatchObject({
      axes: [],
      familyName: "Lato",
      glyphCount: 3023,
      italic: false,
      outlineFormat: "truetype",
      styleName: "Regular",
      weightClass: 400,
    });
    expect(description.metrics.unitsPerEm).toBe(2000);
    expect(description.layout.substitution).toContain("liga");
    expect(description.layout.positioning).toContain("kern");
    expect(description.licence.description).toContain("Open Font License");
  });

  it("keeps characters and glyphs apart", () => {
    const face = harfBuzzReader.open(fontBytes("lato"));
    const ligature = face.shape("fi").glyphs;
    expect(ligature).toHaveLength(1);
    expect(face.charactersForGlyph(ligature[0]?.glyphId ?? 0)).toEqual([
      0xfb_01,
    ]);
    const unmapped = face
      .shape("ffl", { features: { liga: true } })
      .glyphs.map((glyph) => face.charactersForGlyph(glyph.glyphId));
    expect(unmapped.flat().every((code) => code > 0xff)).toBe(true);
    expect(face.shape("fi", { features: { liga: false } }).glyphs).toHaveLength(
      2
    );
    const space = face.glyphForCharacter(0x20) ?? 0;
    expect(face.charactersForGlyph(space).length).toBeGreaterThan(1);
    expect(face.glyphForCharacter(0x09_15)).toBeUndefined();
  });

  it("reads a variable face and its instances", () => {
    const face = harfBuzzReader.open(fontBytes("sofia"));
    expect(face.description.axes).toEqual([
      { default: 400, max: 1000, min: 1, name: "Weight", tag: "wght" },
    ]);
    expect(face.description.instances).toHaveLength(9);
    expect(
      face.description.instances.find((instance) => instance.name === "Bold")
        ?.location
    ).toEqual({ wght: 700 });
    const glyphId = face.glyphForCharacter(0x61) ?? 0;
    const light = face.glyph(glyphId, { wght: 100 });
    const black = face.glyph(glyphId, { wght: 1000 });
    expect(black.advance).toBeGreaterThan(light.advance);
    expect(outlineBounds(face.glyph(glyphId).outline)).toBeDefined();
  });

  it("shapes Devanagari conjuncts and reorders vowel signs", () => {
    const face = harfBuzzReader.open(fontBytes("devanagari"));
    const conjunct = face.shape("क्ष").glyphs;
    expect(conjunct).toHaveLength(1);
    expect(face.charactersForGlyph(conjunct[0]?.glyphId ?? 0)).toEqual([]);
    const word = face
      .shape("कि")
      .glyphs.map((glyph) => face.glyphName(glyph.glyphId));
    expect(word[0]).toContain("093F");
  });

  it("shapes right-to-left text in visual order", () => {
    const face = harfBuzzReader.open(fontBytes("lato"));
    expect(face.shape("אב").direction).toBe("rtl");
    expect(face.shape("ab").direction).toBe("ltr");
  });

  it("refuses files that are not fonts", () => {
    expect(() => harfBuzzReader.open(new Uint8Array([1, 2, 3, 4]))).toThrow(
      UnreadableFontError
    );
    expect(() =>
      harfBuzzReader.open(
        new TextEncoder().encode("this is not a font file at all")
      )
    ).toThrow(UnreadableFontError);
    expect(() => harfBuzzReader.open(fontBytes("lato").slice(0, 2000))).toThrow(
      UnreadableFontError
    );
    expect(() => harfBuzzReader.open(fontBytes("lato"), 3)).toThrow(
      "no face 3"
    );
  });
});
