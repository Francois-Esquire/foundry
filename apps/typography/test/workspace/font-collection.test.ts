/**
 * Proves what test/fixtures/fonts/README.md says about the fonts added for
 * the workspace: each claim there has an assertion here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { OpenFace } from "~/typeface/reading";
import { FONTS } from "../helpers/fixtures";
import { fixtureFile, testWorkspace } from "../helpers/workspace";

const BEH = 0x6_28;
const SHIN = 0x5_e9;

describe("the test font collection", () => {
  const faces = new Map<keyof typeof FONTS, OpenFace>();
  const face = (name: keyof typeof FONTS) => {
    const opened = faces.get(name);
    if (!opened) {
      throw new Error(`${name} was not imported`);
    }
    return opened;
  };

  beforeAll(async () => {
    const workspace = testWorkspace();
    const names = Object.keys(FONTS) as (keyof typeof FONTS)[];
    const reports = await workspace.importFonts(names.map(fixtureFile));
    for (const [index, report] of reports.entries()) {
      const name = names[index];
      if (report.status === "imported" && name) {
        faces.set(name, workspace.openFace(report.faceIds[0] ?? ""));
      }
    }
  });

  it("imports every font in the collection", () => {
    expect([...faces.keys()].sort()).toEqual(Object.keys(FONTS).sort());
  });

  it("has a variable face with Latin, Greek and Cyrillic characters", () => {
    const sofia = face("sofia");
    expect(sofia.description.axes.map((axis) => axis.tag)).toEqual(["wght"]);
    for (const character of [0x41, 0x3_a9, 0x4_16]) {
      expect(sofia.glyphForCharacter(character)).toBeDefined();
    }
  });

  it("has a static face with PostScript outlines", () => {
    const { description } = face("postscript");
    expect(description).toMatchObject({
      axes: [],
      familyName: "Source Code Pro",
      outlineFormat: "cff",
    });
    const letterO = face("postscript").glyphForCharacter(0x4f) ?? 0;
    const kinds = face("postscript")
      .glyph(letterO)
      .outline.contours.flatMap((contour) => contour.segments)
      .map((segment) => segment.kind);
    expect(kinds).toContain("cubic");
    expect(kinds).not.toContain("quadratic");
    expect(description.licence.description).toContain("Open Font License");
  });

  it("has a variable Arabic face whose letters change form by position", () => {
    const arabic = face("arabic");
    expect(arabic.description.familyName).toBe("Noto Naskh Arabic");
    expect(arabic.description.axes.map((axis) => axis.tag)).toEqual(["wght"]);
    expect(arabic.description.layout.scripts).toContain("arab");
    expect(arabic.description.layout.substitution).toEqual(
      expect.arrayContaining(["init", "medi", "fina"])
    );
    const isolated = arabic.glyphForCharacter(BEH);
    const run = arabic.shape("ببب");
    expect(run.direction).toBe("rtl");
    const forms = new Set(
      run.glyphs
        .filter((glyph) => glyph.xAdvance > 0)
        .map((glyph) => glyph.glyphId)
    );
    expect(forms.size).toBe(3);
    expect(forms.has(isolated ?? 0)).toBe(false);
    for (const form of forms) {
      expect(arabic.charactersForGlyph(form)).toEqual([]);
    }
    expect(arabic.description.licence.description).toContain(
      "Open Font License"
    );
  });

  it("has a static Hebrew face that sets right to left and places vowel points", () => {
    const hebrew = face("hebrew");
    expect(hebrew.description).toMatchObject({
      axes: [],
      familyName: "David Libre",
      outlineFormat: "truetype",
    });
    expect(hebrew.description.layout.scripts).toContain("hebr");
    const run = hebrew.shape("שָׁלוֹם");
    expect(run.direction).toBe("rtl");
    expect(run.glyphs.at(-1)?.glyphId).toBe(hebrew.glyphForCharacter(SHIN));
    const marks = run.glyphs.filter((glyph) => glyph.xAdvance === 0);
    expect(marks).toHaveLength(3);
    expect(marks.every((mark) => mark.xOffset !== 0)).toBe(true);
    expect(hebrew.glyphForCharacter(0x41)).toBeDefined();
    expect(hebrew.description.licence.description).toContain(
      "Open Font License"
    );
  });
});
