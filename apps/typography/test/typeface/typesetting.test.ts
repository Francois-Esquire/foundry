import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { EMPTY_WORKING_FACE, foldChanges } from "~/typeface/changes";
import { setText } from "~/typeface/typesetting";
import { fontBytes, TRIANGLE } from "../helpers/fixtures";

const FACE = "face";

describe("setText", () => {
  const face = harfBuzzReader.open(fontBytes("lato"));
  const glyphA = face.glyphForCharacter(0x61) ?? 0;

  it("matches the source font's own shaping when nothing has changed", () => {
    const line = setText("AVfi", face, EMPTY_WORKING_FACE);
    const run = face.shape("AVfi");
    expect(line.glyphs.map((glyph) => glyph.advance)).toEqual(
      run.glyphs.map((glyph) => glyph.xAdvance)
    );
    expect(line.width).toBe(
      run.glyphs.reduce((sum, glyph) => sum + glyph.xAdvance, 0)
    );
    expect(line.glyphs).toHaveLength(3);
    expect(line.glyphs.some((glyph) => glyph.missing)).toBe(false);
  });

  it("shows an edited advance and outline at once, and keeps kerning on top", () => {
    const source = face.glyph(glyphA);
    const working = foldChanges([
      {
        advance: source.advance + 100,
        faceId: FACE,
        glyph: { glyphId: glyphA, kind: "source" },
        kind: "advance-changed",
      },
      {
        faceId: FACE,
        glyph: { glyphId: glyphA, kind: "source" },
        kind: "outline-replaced",
        outline: TRIANGLE,
      },
    ]);
    const before = setText("Ta", face, EMPTY_WORKING_FACE);
    const after = setText("Ta", face, working);
    expect(after.glyphs[1]?.advance).toBe(
      (before.glyphs[1]?.advance ?? 0) + 100
    );
    expect(after.glyphs[1]?.outline).toBe(TRIANGLE);
    expect(after.glyphs[0]?.advance).toBe(before.glyphs[0]?.advance);
    expect(before.glyphs[0]?.advance).toBeLessThan(
      face.glyph(face.glyphForCharacter(0x54) ?? 0).advance
    );
  });

  it("sets an added glyph for a character the source font lacks", () => {
    const working = foldChanges([
      {
        faceId: FACE,
        glyph: {
          advance: 900,
          characters: [0x09_15],
          key: "ka",
          name: "ka-deva",
          outline: TRIANGLE,
          provenance: { origin: "manual" },
        },
        kind: "glyph-added",
      },
    ]);
    const missing = setText("aक", face, EMPTY_WORKING_FACE);
    expect(missing.glyphs[1]?.missing).toBe(true);
    const line = setText("aक", face, working);
    expect(line.glyphs[1]).toMatchObject({
      advance: 900,
      missing: false,
      ref: { key: "ka", kind: "added" },
    });
    expect(line.glyphs[1]?.x).toBe(line.glyphs[0]?.advance);
    expect(line.width).toBe((line.glyphs[0]?.advance ?? 0) + 900);
  });

  it("follows a variable face to an axis location", () => {
    const variable = harfBuzzReader.open(fontBytes("sofia"));
    const light = setText("Hamburg", variable, EMPTY_WORKING_FACE, {
      location: { wght: 100 },
    });
    const black = setText("Hamburg", variable, EMPTY_WORKING_FACE, {
      location: { wght: 1000 },
    });
    expect(black.width).toBeGreaterThan(light.width);
  });

  it("lays mixed directions out in the order they are read", () => {
    const hebrew = harfBuzzReader.open(fontBytes("hebrew"));
    const latinThenHebrew = setText("Hi שלום", hebrew, EMPTY_WORKING_FACE);
    expect(latinThenHebrew.glyphs.map((glyph) => glyph.cluster)).toEqual([
      0, 1, 2, 6, 5, 4, 3,
    ]);
    const hebrewThenLatin = setText("שלום Hi", hebrew, EMPTY_WORKING_FACE);
    expect(hebrewThenLatin.direction).toBe("rtl");
    expect(hebrewThenLatin.glyphs.map((glyph) => glyph.cluster)).toEqual([
      5, 6, 4, 3, 2, 1, 0,
    ]);
  });

  it("keeps a number reading left to right inside Arabic", () => {
    const arabic = harfBuzzReader.open(fontBytes("arabic"));
    const line = setText("سنة 2024", arabic, EMPTY_WORKING_FACE);
    expect(line.glyphs.slice(0, 4).map((glyph) => glyph.cluster)).toEqual([
      4, 5, 6, 7,
    ]);
    expect(line.glyphs.some((glyph) => glyph.missing)).toBe(false);
  });

  it("sets every character of a cluster that uses added glyphs", () => {
    const added = (key: string, character: number, advance: number) =>
      ({
        faceId: FACE,
        glyph: {
          advance,
          characters: [character],
          key,
          name: key,
          outline: TRIANGLE,
          provenance: { origin: "manual" },
        },
        kind: "glyph-added",
      }) as const;
    const working = foldChanges([
      added("shin", 0x05_e9, 1000),
      added("qamats", 0x05_b8, 0),
    ]);
    const line = setText("שָ", face, working);
    expect(
      line.glyphs
        .map((glyph) => (glyph.ref.kind === "added" ? glyph.ref.key : "source"))
        .sort()
    ).toEqual(["qamats", "shin"]);
    expect(line.width).toBe(1000);
  });

  it("uses an added glyph for a character the source font already has", () => {
    const working = foldChanges([
      {
        faceId: FACE,
        glyph: {
          advance: 777,
          characters: [0x41],
          key: "altA",
          name: "A.alt",
          outline: TRIANGLE,
          provenance: { origin: "manual" },
        },
        kind: "glyph-added",
      },
    ]);
    const line = setText("AB", face, working);
    expect(line.glyphs[0]).toMatchObject({
      advance: 777,
      ref: { key: "altA", kind: "added" },
    });
    expect(line.glyphs[1]?.ref.kind).toBe("source");
  });
});
