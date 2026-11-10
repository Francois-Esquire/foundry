/** The proof on fonts the engine really built from the fixtures. */
import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import type { BuildRequest, FontBuilder } from "~/packaging/building";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { type Proof, proveFont } from "~/proof/proof";
import { PIXEL } from "~/proof/visual-regression";
import type { OpenFace } from "~/typeface/reading";
import { fontBytes, TRIANGLE } from "../helpers/fixtures";
import {
  charactersOf,
  glyphOf,
  requestFor,
} from "../packaging/helpers/requests";

describe("proving a derived font", () => {
  let builder: FontBuilder;
  let lato: OpenFace;
  let sofia: OpenFace;

  const prove = async (
    source: OpenFace,
    request: BuildRequest,
    texts: readonly string[]
  ): Promise<Proof> =>
    proveFont({
      builder,
      bytes: (await builder.build(request)).bytes,
      reader: harfBuzzReader,
      request,
      samples: texts.map((text) => ({ text })),
      source,
    });

  beforeAll(async () => {
    builder = await nodeFontBuilder();
    lato = harfBuzzReader.open(fontBytes("lato"));
    sofia = harfBuzzReader.open(fontBytes("sofia"));
  });

  it("finds no differing pixel in a subset whose glyphs are unchanged", async () => {
    const proof = await prove(
      lato,
      requestFor(fontBytes("lato"), {
        familyName: "Atlas Sans",
        subset: { characters: charactersOf("office AV Waffle") },
      }),
      ["office", "AV", "Waffle", "क्ष"]
    );
    expect(proof.regression.map((test) => test.verdict)).toEqual([
      "same",
      "same",
      "same",
      "not-checked",
    ]);
    expect(proof.regression[0]?.difference).toMatchObject({
      derivedOnly: 0,
      share: 0,
      sourceOnly: 0,
    });
    expect(proof.regression[0]?.difference?.inked).toBeGreaterThan(1000);
    expect(proof.shaping.map((test) => test.verdict)).toEqual([
      "pass",
      "pass",
      "pass",
      "not-checked",
    ]);
    // Lato joins f, f and i into one glyph: six characters become four glyphs in both fonts.
    expect(proof.shaping[0]).toMatchObject({
      derived: { clusters: [0, 1, 4, 5], glyphCount: 4 },
      joins: true,
      source: { clusters: [0, 1, 4, 5], glyphCount: 4 },
    });
    expect(proof.shaping[3]).toMatchObject({
      derived: undefined,
      source: undefined,
    });
    expect(proof.changed).toEqual([]);
    expect(proof.description.familyName).toBe("Atlas Sans");
    expect([...proof.characters].sort((a, b) => a - b)).toEqual(
      [...new Set(charactersOf("office AV Waffle"))].sort((a, b) => a - b)
    );
  });

  it("shows where a redrawn glyph differs and leaves other text alone", async () => {
    const a = glyphOf(lato, "a");
    const proof = await prove(
      lato,
      requestFor(fontBytes("lato"), {
        added: [
          {
            advance: 1000,
            characters: [0xe0_00],
            key: "mark",
            name: "triangle",
            outline: TRIANGLE,
            provenance: {
              createdAt: "2026-11-10T09:00:00.000Z",
              origin: "generated",
              runId: "run-1",
              strategy: "procedural",
            },
          },
        ],
        overrides: new Map([
          [a, { outline: TRIANGLE, provenance: { origin: "manual" } }],
          [glyphOf(lato, "V"), { advance: 1500 }],
        ]),
      }),
      ["office", "data", "\u{e000}"]
    );
    expect(proof.regression.map((test) => test.verdict)).toEqual([
      "same",
      "changed",
      "changed",
    ]);
    const [, data, added] = proof.regression;
    expect(data?.difference?.share).toBeGreaterThan(0.2);
    expect(data?.difference?.picture.data).toContain(PIXEL.sourceOnly);
    expect(data?.difference?.picture.data).toContain(PIXEL.derivedOnly);
    expect(data?.difference?.picture.data).toContain(PIXEL.both);
    // The source has no glyph for the added character, so only the derived font inks it.
    expect(added?.difference?.derivedOnly).toBeGreaterThan(0);
    expect(added?.difference?.sourceOnly).toBe(0);
    expect(added?.difference?.share).toBe(1);
    expect(
      proof.changed.map(({ change, characters, name, presence }) => ({
        change,
        characters,
        name,
        presence,
      }))
    ).toEqual([
      {
        change: "respaced",
        characters: [0x56],
        name: lato.glyphName(glyphOf(lato, "V")),
        presence: "present",
      },
      {
        change: "redrawn",
        characters: [0x61],
        name: lato.glyphName(a),
        presence: "present",
      },
      {
        change: "added",
        characters: [0xe0_00],
        name: "triangle",
        presence: "present",
      },
    ]);
    // The outlines are read back from the built font, not from the request.
    expect(proof.changed[1]?.outline?.contours).toHaveLength(1);
    expect(proof.changed[2]?.outline?.contours).toHaveLength(1);
    expect(proof.changed[2]?.provenance?.origin).toBe("generated");
  });

  it("finds changed glyphs again in a subset, which renumbers them", async () => {
    const ligature = lato.shape("fi").glyphs[0]?.glyphId ?? 0;
    const proof = await prove(
      lato,
      requestFor(fontBytes("lato"), {
        overrides: new Map([
          [glyphOf(lato, "a"), { outline: TRIANGLE }],
          [glyphOf(lato, "i"), { outline: TRIANGLE }],
          [ligature, { advance: 900 }],
        ]),
        subset: { characters: charactersOf("fi") },
      }),
      ["fi", "if"]
    );
    const presence = Object.fromEntries(
      proof.changed.map((glyph) => [glyph.characters.join(), glyph.presence])
    );
    expect(presence).toEqual({
      // The selection leaves out a, and the ligature's own character U+FB01.
      // The ligature is still in the file, reached by a layout rule, but a
      // renumbered file cannot be asked for a glyph without a character.
      [String(0x61)]: "untraceable",
      [String(0x69)]: "present",
      [String(0xfb_01)]: "untraceable",
    });
    expect(
      proof.changed.find((glyph) => glyph.presence === "present")?.outline
        ?.contours
    ).toHaveLength(1);
    // "fi" is the ligature alone, and a new advance moves nothing that
    // follows it, so the line draws the same. "if" shows the redrawn i.
    expect(proof.regression.map((test) => test.verdict)).toEqual([
      "same",
      "changed",
    ]);
  });

  it("proves a WOFF2 file by unpacking it first", async () => {
    const proof = await prove(
      lato,
      requestFor(fontBytes("lato"), {
        flavor: "woff2",
        subset: { characters: charactersOf("office") },
      }),
      ["office"]
    );
    expect(proof.regression[0]?.verdict).toBe("same");
    expect(proof.shaping[0]?.verdict).toBe("pass");
  });

  it("does not pass a font built on an empty source on the spaces the two share", async () => {
    const blank = await builder.blankFont({
      familyName: "Storefront",
      metrics: { ascender: 800, descender: -200, lineGap: 0, unitsPerEm: 1000 },
      styleName: "Regular",
    });
    const letter = (name: string) => ({
      advance: 1000,
      characters: charactersOf(name),
      key: name,
      name,
      outline: TRIANGLE,
      provenance: {
        basis: "observed",
        evidenceId: "photograph",
        origin: "reconstructed",
      } as const,
    });
    const source = harfBuzzReader.open(blank.bytes);
    try {
      const proof = await prove(
        source,
        requestFor(blank.bytes, { added: [letter("A"), letter("V")] }),
        ["A V A"]
      );
      expect(proof.shaping[0]).toMatchObject({
        derived: undefined,
        source: undefined,
        verdict: "not-checked",
      });
      expect(proof.shaping[0]?.detail).toContain(
        "the source font draws none of its characters"
      );
    } finally {
      source.close();
    }
  });

  it("compares a pinned instance with the source at the same location", async () => {
    const proof = await prove(
      sofia,
      requestFor(fontBytes("sofia"), {
        location: { wght: 700 },
        styleName: "Bold",
        subset: { characters: charactersOf("Letters carry") },
      }),
      ["Letters carry"]
    );
    expect(proof.shaping[0]?.verdict).toBe("pass");
    // Pinning rounds interpolated points to whole units, so a few edge pixels
    // move. The proof reports that as it is and does not call it a pass.
    expect(proof.approximation).toBe("pinned");
    expect(proof.regression[0]?.verdict).toBe("inconclusive");
    expect(proof.regression[0]?.difference?.share).toBeGreaterThan(0);
    expect(proof.regression[0]?.difference?.share).toBeLessThan(0.02);
  });
});
