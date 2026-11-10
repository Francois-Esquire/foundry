/**
 * The spine of the product in one test: import a font, inspect it, change it
 * without touching the source, build a derived font, and prove the derived
 * font reloads and still shapes. Every later feature hangs off this path.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import type { BuiltFont, FontBuilder } from "~/packaging/building";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { sourceGlyph } from "~/typeface/changes";
import { translateOutline } from "~/typeface/outline";
import {
  addSource,
  commit,
  digestOf,
  emptyProject,
  sourceOf,
  type TypefaceProject,
  undo,
  workingFaceOf,
} from "~/typeface/project";
import type { OpenFace } from "~/typeface/reading";
import { fontBytes, TRIANGLE } from "./helpers/fixtures";

const PRIVATE_USE = 0xe0_00;

describe("import, edit, build, reload", () => {
  const original = fontBytes("lato");
  let builder: FontBuilder;
  let source: OpenFace;
  let project: TypefaceProject;
  let faceId: string;
  let built: BuiltFont;
  let derived: OpenFace;
  let glyphA: number;

  beforeAll(async () => {
    builder = await nodeFontBuilder();
    source = harfBuzzReader.open(original);
    const digest = await digestOf(original);
    const imported = addSource(
      emptyProject(),
      {
        bytes: original,
        fileName: "Lato-Regular.ttf",
        id: digest,
        importedAt: new Date().toISOString(),
      },
      [source.description]
    );
    faceId = imported.faces[0]?.id ?? "";
    glyphA = source.glyphForCharacter(0x61) ?? 0;
    const glyphB = source.glyphForCharacter(0x62) ?? 0;
    const { glyphNames } = await builder.describeLayout(original);
    const shape = source.glyph(glyphA);
    project = commit(imported, {
      changes: [
        {
          advance: shape.advance + 40,
          faceId,
          glyph: sourceGlyph(glyphA),
          kind: "advance-changed",
        },
        {
          faceId,
          glyph: sourceGlyph(glyphA),
          kind: "outline-replaced",
          outline: translateOutline(shape.outline, 20, 0),
        },
        {
          faceId,
          glyph: {
            advance: 1000,
            characters: [PRIVATE_USE],
            key: "tri",
            name: "triangle",
            outline: TRIANGLE,
            provenance: { origin: "manual" },
          },
          kind: "glyph-added",
        },
        {
          code: `languagesystem DFLT dflt; languagesystem latn dflt;
feature liga { sub ${glyphNames[glyphA]} ${glyphNames[glyphB]} by triangle; } liga;`,
          description: "Ligature a b to triangle",
          faceId,
          kind: "features-added",
        },
      ],
      label: "Edit a, add a glyph and a ligature",
    });
    const working = workingFaceOf(project, faceId);
    built = await builder.build({
      added: working.added,
      faceIndex: 0,
      familyName: "Lato Derived",
      featureCode: working.featureCode,
      overrides: working.overrides,
      source: sourceOf(project, faceId).bytes,
    });
    derived = harfBuzzReader.open(built.bytes);
  });

  it("builds a derived font that reloads with one more glyph", () => {
    expect(built.glyphCount).toBe(source.description.glyphCount + 1);
    expect(derived.description.familyName).toBe("Lato Derived");
    expect(derived.description.characterCount).toBe(
      source.description.characterCount + 1
    );
  });

  it("carries the edits into the derived font", () => {
    const before = source.glyph(glyphA);
    const after = derived.glyph(derived.glyphForCharacter(0x61) ?? 0);
    expect(after.advance).toBe(before.advance + 40);
    expect(after.outline.contours[0]?.start.x).toBe(
      (before.outline.contours[0]?.start.x ?? 0) + 20
    );
    const added = derived.glyphForCharacter(PRIVATE_USE);
    expect(added).toBe(source.description.glyphCount);
    expect(derived.glyph(added ?? 0).advance).toBe(1000);
  });

  it("keeps the source font's shaping and adds the new rule", () => {
    expect(derived.shape("fi").glyphs).toHaveLength(1);
    expect(derived.shape("AV").glyphs[0]?.xAdvance).toBe(
      source.shape("AV").glyphs[0]?.xAdvance
    );
    expect(source.shape("ab").glyphs).toHaveLength(2);
    expect(derived.shape("ab").glyphs.map((glyph) => glyph.glyphId)).toEqual([
      derived.glyphForCharacter(PRIVATE_USE),
    ]);
  });

  it("passes the engine's validation", async () => {
    const report = await builder.validate(built.bytes);
    expect(report.issues.filter((issue) => issue.severity === "error")).toEqual(
      []
    );
    expect(report.loadable).toBe(true);
    expect(
      (await builder.validate(new Uint8Array([0, 1, 2, 3]))).loadable
    ).toBe(false);
  });

  it("leaves the source untouched and reversible", async () => {
    expect(sourceOf(project, faceId).bytes).toBe(original);
    expect(await digestOf(sourceOf(project, faceId).bytes)).toBe(
      project.sources[0]?.id
    );
    expect(workingFaceOf(undo(project), faceId).added).toHaveLength(0);
  });

  it("subsets with the glyphs shaping needs, after pinning a variable source", async () => {
    const subset = await builder.build({
      added: [],
      faceIndex: 0,
      featureCode: [],
      location: { wght: 700 },
      overrides: new Map(),
      source: fontBytes("devanagari"),
      subset: { characters: [0x09_15, 0x09_4d, 0x09_37] },
    });
    const face = harfBuzzReader.open(subset.bytes);
    expect(face.description.axes).toEqual([]);
    expect(face.description.characterCount).toBe(3);
    expect(face.shape("क्ष").glyphs).toHaveLength(1);
    expect(subset.bytes.byteLength).toBeLessThan(20_000);
  });
});
