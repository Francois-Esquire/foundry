/**
 * Proves the machinery for extending a Latin face into another script: added
 * glyphs plus feature code give working shaping in a built font. Lato has no
 * Devanagari, so every Devanagari result here comes from what the test adds.
 *
 * The outlines are stand-ins copied from Noto Sans Devanagari. This test is
 * about composition and shaping, not about how the glyphs were drawn.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { nodeFontBuilder } from "~/packaging/engine/node";
import type { AddedGlyph, Change } from "~/typeface/changes";
import {
  type Bounds,
  outlineBounds,
  transformOutline,
} from "~/typeface/outline";
import {
  addSource,
  commit,
  digestOf,
  emptyProject,
  workingFaceOf,
} from "~/typeface/project";
import type { OpenFace } from "~/typeface/reading";
import { fontBytes } from "./helpers/fixtures";

const LETTERS = {
  "aaMatra-deva": 0x09_3e,
  "iMatra-deva": 0x09_3f,
  "ka-deva": 0x09_15,
  "ma-deva": 0x09_2e,
  "na-deva": 0x09_28,
  "ra-deva": 0x09_30,
  "sa-deva": 0x09_38,
  "ssa-deva": 0x09_37,
  "ta-deva": 0x09_24,
} as const;

const MARKS = {
  "anusvara-deva": 0x09_02,
  "eMatra-deva": 0x09_47,
  "virama-deva": 0x09_4d,
} as const;

const BASES = [
  "ka-deva",
  "ta-deva",
  "na-deva",
  "ma-deva",
  "ra-deva",
  "sa-deva",
  "ssa-deva",
] as const;

const boundsOf = (glyph: AddedGlyph): Bounds => {
  const bounds = outlineBounds(glyph.outline);
  if (!bounds) {
    throw new Error(`${glyph.name} has no outline`);
  }
  return bounds;
};

describe("extending Lato with a Devanagari subset", () => {
  let derived: OpenFace;
  let firstAdded: number;
  const glyphs: AddedGlyph[] = [];
  const idOf = (name: string) =>
    firstAdded + glyphs.findIndex((glyph) => glyph.name === name);
  const shapedNames = (text: string) =>
    derived
      .shape(text)
      .glyphs.map(
        (glyph) =>
          glyphs[glyph.glyphId - firstAdded]?.name ?? `source:${glyph.glyphId}`
      );

  beforeAll(async () => {
    const lato = fontBytes("lato");
    const source = harfBuzzReader.open(lato);
    const donor = harfBuzzReader.open(fontBytes("devanagari"));
    const scale =
      source.description.metrics.unitsPerEm /
      donor.description.metrics.unitsPerEm;
    const borrow = (
      name: string,
      glyphId: number,
      characters: number[]
    ): AddedGlyph => {
      const shape = donor.glyph(glyphId);
      return {
        advance: Math.round(shape.advance * scale),
        characters,
        key: name,
        name,
        outline: transformOutline(shape.outline, {
          dx: 0,
          dy: 0,
          xx: scale,
          xy: 0,
          yx: 0,
          yy: scale,
        }),
        provenance: { origin: "manual" },
      };
    };
    for (const [name, code] of Object.entries({ ...LETTERS, ...MARKS })) {
      glyphs.push(borrow(name, donor.glyphForCharacter(code) ?? 0, [code]));
    }
    // Forms with no character of their own: read them from the donor's shaping.
    glyphs.push(
      borrow("sa-deva.half", donor.shape("स्त").glyphs[0]?.glyphId ?? 0, [])
    );
    glyphs.push(
      borrow("na-deva.half", donor.shape("न्त").glyphs[0]?.glyphId ?? 0, [])
    );
    glyphs.push(
      borrow("kssa-deva", donor.shape("क्ष").glyphs[0]?.glyphId ?? 0, [])
    );

    const named = (name: string) => {
      const glyph = glyphs.find((candidate) => candidate.name === name);
      if (!glyph) {
        throw new Error(`missing ${name}`);
      }
      return glyph;
    };
    const headline = boundsOf(named("ka-deva")).yMax;
    // A mark above hangs from the headline over the base letter's right-hand stem.
    const markAnchor = (name: string) => {
      const bounds = boundsOf(named(name));
      return `<anchor ${Math.round(bounds.xMax)} ${Math.round(headline)}>`;
    };
    const baseAnchor = (name: string) =>
      `<anchor ${Math.round(boundsOf(named(name)).xMax)} ${Math.round(headline)}>`;
    const code = `
languagesystem DFLT dflt;
languagesystem dev2 dflt;

feature akhn {
  sub ka-deva virama-deva ssa-deva by kssa-deva;
} akhn;

feature half {
  sub sa-deva virama-deva by sa-deva.half;
  sub na-deva virama-deva by na-deva.half;
} half;

markClass eMatra-deva ${markAnchor("eMatra-deva")} @above;
markClass anusvara-deva ${markAnchor("anusvara-deva")} @above;

feature abvm {
${BASES.map((name) => `  pos base ${name} ${baseAnchor(name)} mark @above;`).join("\n")}
} abvm;
`;
    const digest = await digestOf(lato);
    const imported = addSource(
      emptyProject(),
      {
        bytes: lato,
        fileName: "Lato-Regular.ttf",
        id: digest,
        importedAt: "2026-11-10T00:00:00.000Z",
      },
      [source.description]
    );
    const faceId = imported.faces[0]?.id ?? "";
    const changes: Change[] = [
      ...glyphs.map(
        (glyph): Change => ({ faceId, glyph, kind: "glyph-added" })
      ),
      {
        code,
        description: "Devanagari subset: conjunct, half forms, marks above",
        faceId,
        kind: "features-added",
      },
    ];
    const working = workingFaceOf(
      commit(imported, { changes, label: "Add a Devanagari subset" }),
      faceId
    );
    const builder = await nodeFontBuilder();
    const built = await builder.build({
      added: working.added,
      faceIndex: 0,
      familyName: "Extension Test",
      featureCode: working.featureCode,
      overrides: working.overrides,
      source: lato,
    });
    expect(
      (await builder.validate(built.bytes)).issues.filter(
        (issue) => issue.severity === "error"
      )
    ).toEqual([]);
    derived = harfBuzzReader.open(built.bytes);
    firstAdded = source.description.glyphCount;
  });

  it("maps every added character and declares the script", () => {
    for (const code of [...Object.values(LETTERS), ...Object.values(MARKS)]) {
      expect(derived.glyphForCharacter(code)).toBeGreaterThanOrEqual(
        firstAdded
      );
    }
    expect(derived.description.layout.scripts).toContain("dev2");
    expect(derived.description.layout.substitution).toEqual(
      expect.arrayContaining(["akhn", "half", "liga"])
    );
  });

  it("forms a half letter inside a conjunct: नमस्ते", () => {
    expect(shapedNames("नमस्ते")).toEqual([
      "na-deva",
      "ma-deva",
      "sa-deva.half",
      "ta-deva",
      "eMatra-deva",
    ]);
  });

  it("moves the short i vowel sign before its consonant: सितार", () => {
    expect(shapedNames("सितार")).toEqual([
      "iMatra-deva",
      "sa-deva",
      "ta-deva",
      "aaMatra-deva",
      "ra-deva",
    ]);
  });

  it("joins क्ष into one conjunct glyph", () => {
    expect(shapedNames("क्ष")).toEqual(["kssa-deva"]);
  });

  it("hangs a mark above from the base letter's anchor", () => {
    const [base, mark] = derived.shape("कं").glyphs;
    expect([base?.glyphId, mark?.glyphId]).toEqual([
      idOf("ka-deva"),
      idOf("anusvara-deva"),
    ]);
    expect(mark?.xAdvance).toBe(0);
    const baseRight = Math.round(
      boundsOf(glyphs[idOf("ka-deva") - firstAdded] as AddedGlyph).xMax
    );
    const markRight = Math.round(
      boundsOf(glyphs[idOf("anusvara-deva") - firstAdded] as AddedGlyph).xMax
    );
    expect(mark?.xOffset).toBe(baseRight - markRight - (base?.xAdvance ?? 0));
  });

  it("keeps Latin shaping from the source font in the same line", () => {
    expect(
      derived.shape("fi नाम").glyphs.map((glyph) => glyph.glyphId >= firstAdded)
    ).toEqual([false, false, true, true, true]);
  });
});
