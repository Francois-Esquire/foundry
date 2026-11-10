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
});
