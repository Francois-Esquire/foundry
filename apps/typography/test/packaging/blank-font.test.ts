/**
 * The blank source font: what a reconstruction that starts from an image
 * hangs its candidates on. It has to behave like any imported source font.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import {
  type BlankFontRequest,
  BuildError,
  type BuiltFont,
  type FontBuilder,
} from "~/packaging/building";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { readLicence } from "~/packaging/licence";
import { outlineBounds } from "~/typeface/outline";
import type { OpenFace } from "~/typeface/reading";
import { TRIANGLE } from "../helpers/fixtures";
import { requestFor } from "./helpers/requests";

const STOREFRONT: BlankFontRequest = {
  familyName: "Storefront",
  metrics: {
    ascender: 1600,
    capHeight: 1400,
    descender: -400,
    lineGap: 100,
    unitsPerEm: 2000,
    xHeight: 1000,
  },
  styleName: "Regular",
};

describe("a blank source font", () => {
  let builder: FontBuilder;
  let blank: BuiltFont;
  let face: OpenFace;

  const refusal = (request: BlankFontRequest) =>
    builder.blankFont(request).then(
      () => {
        throw new Error("The font should have been refused.");
      },
      (error: unknown) => error as Error
    );

  beforeAll(async () => {
    builder = await nodeFontBuilder();
    blank = await builder.blankFont(STOREFRONT);
    face = harfBuzzReader.open(blank.bytes);
  }, 120_000);

  it("opens with the names and vertical metrics it was given", () => {
    expect(face.description).toMatchObject({
      axes: [],
      familyName: "Storefront",
      fullName: "Storefront Regular",
      italic: false,
      metrics: STOREFRONT.metrics,
      outlineFormat: "truetype",
      postScriptName: "Storefront-Regular",
      styleName: "Regular",
      weightClass: 400,
    });
  });

  it("holds a missing-character glyph and a space, and nothing else", () => {
    expect(blank.glyphCount).toBe(2);
    expect(blank.characterCount).toBe(1);
    expect([...face.characters()]).toEqual([0x20]);
    const missing = face.glyph(0);
    expect(missing.advance).toBe(1000);
    expect(missing.outline.contours).toHaveLength(2);
    const space = face.glyph(face.glyphForCharacter(0x20) ?? 0);
    expect(space).toEqual({ advance: 500, outline: { contours: [] } });
    expect(face.shape("A A").glyphs.map((glyph) => glyph.glyphId)).toEqual([
      0, 1, 0,
    ]);
  });

  it("passes the engine's validation", async () => {
    const report = await builder.validate(blank.bytes);
    expect(report.issues).toEqual([]);
    expect(report.loadable).toBe(true);
    expect(report.glyphCount).toBe(2);
  });

  it("is the same file every time, so it is one source font however often it is made", async () => {
    const again = await builder.blankFont(STOREFRONT);
    expect(again.bytes).toEqual(blank.bytes);
  });

  it("takes added glyphs and feature code through a normal build", async () => {
    const added = (name: string, character: number, advance: number) => ({
      advance,
      characters: [character],
      key: name,
      name,
      outline: TRIANGLE,
      provenance: {
        basis: "observed",
        evidenceId: "storefront-photograph",
        origin: "reconstructed",
      } as const,
    });
    const built = await builder.build(
      requestFor(blank.bytes, {
        added: [
          added("A", 0x41, 1200),
          added("V", 0x56, 1100),
          added("A_V", 0xe0_00, 2000),
        ],
        featureCode: [
          "languagesystem DFLT dflt; languagesystem latn dflt; feature liga { sub A V by A_V; } liga;",
        ],
      })
    );
    const derived = harfBuzzReader.open(built.bytes);
    expect(built.glyphCount).toBe(5);
    expect(derived.description.familyName).toBe("Storefront");
    expect(derived.shape("A A").glyphs.map((glyph) => glyph.xAdvance)).toEqual([
      1200, 500, 1200,
    ]);
    expect(derived.shape("AV").glyphs.map((glyph) => glyph.xAdvance)).toEqual([
      2000,
    ]);
    expect(
      outlineBounds(derived.glyph(derived.glyphForCharacter(0x41) ?? 0).outline)
    ).toEqual(outlineBounds(TRIANGLE));
    expect((await builder.validate(built.bytes)).issues).toEqual([]);
  });

  it("reads the weight and slant from the style name", async () => {
    const heavy = await builder.blankFont({
      ...STOREFRONT,
      styleName: "Bold Italic",
    });
    expect(harfBuzzReader.open(heavy.bytes).description).toMatchObject({
      fullName: "Storefront Bold Italic",
      italic: true,
      styleName: "Bold Italic",
      weightClass: 700,
    });
  });

  it("fills in the heights that were not given", async () => {
    const plain = await builder.blankFont({
      familyName: "Sign",
      metrics: { ascender: 800, descender: -200, lineGap: 0, unitsPerEm: 1000 },
      styleName: "",
    });
    expect(harfBuzzReader.open(plain.bytes).description).toMatchObject({
      metrics: { capHeight: 700, xHeight: 500 },
      styleName: "Regular",
    });
  });

  it("declares no licence, because the lettering is the user's own", () => {
    expect(readLicence(face.description.licence)).toEqual({
      kind: "unknown",
      reservedNames: [],
    });
    expect(face.description.licence.embedding).toBe(0);
  });

  it("refuses a font without a name or with impossible metrics", async () => {
    const unnamed = await refusal({ ...STOREFRONT, familyName: "  " });
    expect(unnamed).toBeInstanceOf(BuildError);
    expect(unnamed.message).toBe("A blank font needs a family name.");
    const tiny = await refusal({
      ...STOREFRONT,
      metrics: { ...STOREFRONT.metrics, unitsPerEm: 8 },
    });
    expect(tiny.message).toBe("Units per em must be between 16 and 16384.");
    const upsideDown = await refusal({
      ...STOREFRONT,
      metrics: { ...STOREFRONT.metrics, descender: 400 },
    });
    expect(upsideDown.message).toBe(
      "The ascender must be above the baseline and the descender at or below it."
    );
  });
});
