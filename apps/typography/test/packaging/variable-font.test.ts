/**
 * Rebuilding a variable font from masters, through the engine's port in
 * Node. The masters are pinned instances of Sofia Sans with hand-made added
 * glyphs, so every number here can be worked out from the masters.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import {
  BuildError,
  type BuiltVariableFont,
  type FontBuilder,
  type VariableBuildRequest,
} from "~/packaging/building";
import { nodeFontBuilder } from "~/packaging/engine/node";
import type { OpenFace } from "~/typeface/reading";
import { fontBytes, TRIANGLE } from "../helpers/fixtures";
import {
  addedBlob,
  addedWedge,
  BLOB_CHARACTER,
  furthestApart,
  furthestFromHalfway,
  masterAt,
  variableRequestFor,
  wedgeMaster,
  wedgeWidthAt,
} from "./helpers/masters";
import { expectPlainSentences } from "./helpers/messages";
import { glyphOf } from "./helpers/requests";

const BUILD_TIMEOUT = 120_000;
const REDRAWN_IN_ONE_MASTER =
  /^The glyph a cannot interpolate: it has \d+ contours in the Light master and 1 in the Bold master\./;
const WEIGHTS = [300, 400, 800] as const;
/** Rounding to whole font units, once in each master and once when interpolating. */
const ROUNDING = 1;

const SQUARE = {
  contours: [
    {
      segments: [
        { kind: "line", to: { x: 100, y: 700 } },
        { kind: "line", to: { x: 800, y: 700 } },
        { kind: "line", to: { x: 800, y: 0 } },
      ],
      start: { x: 100, y: 0 },
    },
  ],
} as const;

describe("rebuilding a variable font from masters", () => {
  const sofia = fontBytes("sofia");
  const sofiaFace = harfBuzzReader.open(sofia);
  let builder: FontBuilder;

  const refusal = (request: VariableBuildRequest) =>
    builder.buildVariable(request).then(
      () => {
        throw new Error("The build should have been refused.");
      },
      (error: unknown) => error as Error
    );

  beforeAll(async () => {
    builder = await nodeFontBuilder();
  }, BUILD_TIMEOUT);

  describe("three masters with the same added glyphs", () => {
    let built: BuiltVariableFont;
    let face: OpenFace;
    const master = (weight: number, styleName: string, blobFirst = false) => {
      const added = [addedWedge(wedgeWidthAt(weight)), addedBlob(weight / 4)];
      return masterAt(weight, styleName, {
        added: blobFirst ? added.toReversed() : added,
      });
    };
    const wedgeAt = (weight: number) =>
      face.glyph(glyphOf(face, "\u{e000}"), { wght: weight });
    const blobAt = (weight: number) =>
      face.glyph(glyphOf(face, "\u{e001}"), { wght: weight });

    beforeAll(async () => {
      // Out of order, and one master lists its added glyphs the other way round.
      built = await builder.buildVariable(
        variableRequestFor(
          sofia,
          [
            master(800, "ExtraBold"),
            master(300, "Light", true),
            master(400, "Regular"),
          ],
          { familyName: "Sofia Rebuilt" }
        )
      );
      face = harfBuzzReader.open(built.bytes);
      console.info("Variable font build in Node (ms):", built.timings);
    }, BUILD_TIMEOUT);

    it("has a weight axis that runs from the first master to the last", () => {
      const axis = {
        default: 400,
        max: 800,
        min: 300,
        name: "Weight",
        tag: "wght",
      };
      expect(built.axis).toEqual(axis);
      expect(face.description.axes).toEqual([axis]);
      expect(face.description.instances).toEqual([
        { location: { wght: 300 }, name: "Light" },
        { location: { wght: 400 }, name: "Regular" },
        { location: { wght: 800 }, name: "ExtraBold" },
      ]);
    });

    it("carries the new family name and the default master's style", () => {
      expect(face.description.familyName).toBe("Sofia Rebuilt");
      expect(face.description.styleName).toBe("Regular");
      expect(face.description.postScriptName).toBe("SofiaRebuilt-Regular");
    });

    it("draws each added glyph as its master did, at the master's weight", () => {
      for (const weight of WEIGHTS) {
        expect(wedgeAt(weight).advance).toBe(wedgeWidthAt(weight) + 200);
        const xs = wedgeAt(weight)
          .outline.contours.flatMap((contour) => [
            contour.start,
            ...contour.segments.map((segment) => segment.to),
          ])
          .map((point) => point.x);
        expect(Math.max(...xs) - Math.min(...xs)).toBe(wedgeWidthAt(weight));
      }
    });

    it("interpolates the added glyphs between masters", () => {
      expect(wedgeAt(350).advance).toBe(
        (wedgeAt(300).advance + wedgeAt(400).advance) / 2
      );
      expect(
        furthestFromHalfway(wedgeAt(350), wedgeAt(300), wedgeAt(400))
      ).toBeLessThanOrEqual(ROUNDING);
      expect(
        furthestFromHalfway(wedgeAt(600), wedgeAt(400), wedgeAt(800))
      ).toBeLessThanOrEqual(ROUNDING);
    });

    it("converts cubic curves so that every master has the same points", () => {
      const [light, regular, heavy] = WEIGHTS.map(blobAt);
      const pointCount = (weight: number) =>
        blobAt(weight).outline.contours.flatMap((contour) => contour.segments)
          .length;
      expect(pointCount(300)).toBeGreaterThanOrEqual(4);
      expect(pointCount(400)).toBe(pointCount(300));
      expect(pointCount(800)).toBe(pointCount(300));
      expect(light?.advance).toBe(350);
      expect(heavy?.advance).toBe(600);
      expect(
        furthestFromHalfway(blobAt(600), blobAt(400), blobAt(800))
      ).toBeLessThanOrEqual(ROUNDING);
      expect(regular && furthestApart(regular, blobAt(800))).toBeGreaterThan(
        50
      );
    });

    it("keeps the source font's own glyphs at each master", () => {
      expect(built.glyphCount).toBe(sofiaFace.description.glyphCount + 2);
      expect(built.characterCount).toBe(
        sofiaFace.description.characterCount + 2
      );
      for (const character of ["a", "H", "g", "Ж", "ß", "é"]) {
        for (const weight of WEIGHTS) {
          const location = { wght: weight };
          const rebuilt = face.glyph(glyphOf(face, character), location);
          const source = sofiaFace.glyph(
            glyphOf(sofiaFace, character),
            location
          );
          expect(furthestApart(rebuilt, source)).toBeLessThanOrEqual(ROUNDING);
        }
      }
    });

    it("keeps the source font's shaping at each master", () => {
      expect(face.description.layout).toEqual(sofiaFace.description.layout);
      for (const weight of WEIGHTS) {
        const options = { location: { wght: weight } };
        for (const text of ["office", "AVATAR", "Tо"]) {
          const rebuilt = face.shape(text, options).glyphs;
          const source = sofiaFace.shape(text, options).glyphs;
          expect(rebuilt.map((glyph) => glyph.glyphId)).toEqual(
            source.map((glyph) => glyph.glyphId)
          );
          for (const [index, glyph] of rebuilt.entries()) {
            const advance = source[index]?.xAdvance ?? Number.NaN;
            expect(Math.abs(glyph.xAdvance - advance)).toBeLessThanOrEqual(
              ROUNDING
            );
          }
        }
      }
      const kerned = (weight: number) =>
        face.shape("AV", { location: { wght: weight } }).glyphs[0]?.xAdvance ??
        0;
      const plain = (weight: number) =>
        face.glyph(glyphOf(face, "A"), { wght: weight }).advance;
      expect(kerned(600)).toBeLessThan(plain(600));
      expect(face.shape("fi").glyphs).toHaveLength(1);
    });

    it("passes the engine's validation", async () => {
      const report = await builder.validate(built.bytes);
      expect(report.issues).toEqual([]);
      expect(report.loadable).toBe(true);
      expect(report.glyphCount).toBe(built.glyphCount);
    });

    it("says what it rebuilt and how long the engine took", () => {
      expect(built.notes).toEqual([
        "Rebuilt the wght axis from 3 masters: 300 to 800, with its default at 400.",
        "Values between two masters are interpolated in a straight line. The source font's own axis mapping and intermediate designs are not carried over.",
      ]);
      expectPlainSentences(built.notes);
      const { checkMs, mastersMs, mergeMs, saveMs, totalMs } = built.timings;
      expect(mastersMs).toBeGreaterThan(0);
      expect(mergeMs).toBeGreaterThan(0);
      expect(saveMs).toBeGreaterThan(0);
      expect(
        Math.abs(totalMs - mastersMs - checkMs - mergeMs - saveMs)
      ).toBeLessThan(5);
    });
  });

  describe("two masters with redrawn glyphs, changed advances and feature code", () => {
    const FEATURE =
      "languagesystem DFLT dflt; languagesystem latn dflt; feature ss20 { sub x by wedge; } ss20;";
    /** A box on the baseline, as wide as asked. */
    const box = (width: number) => ({
      contours: [
        {
          segments: [
            { kind: "line" as const, to: { x: 50, y: 500 } },
            { kind: "line" as const, to: { x: 50 + width, y: 500 } },
            { kind: "line" as const, to: { x: 50 + width, y: 0 } },
          ],
          start: { x: 50, y: 0 },
        },
      ],
    });
    let built: BuiltVariableFont;
    let face: OpenFace;

    beforeAll(async () => {
      const master = (
        weight: number,
        styleName: string,
        boxWidth: number,
        advance: number
      ) =>
        masterAt(weight, styleName, {
          added: [addedWedge(wedgeWidthAt(weight))],
          featureCode: [FEATURE],
          overrides: new Map([
            [glyphOf(sofiaFace, "o"), { outline: box(boxWidth) }],
            [glyphOf(sofiaFace, "n"), { advance }],
          ]),
        });
      built = await builder.buildVariable(
        variableRequestFor(sofia, [
          master(300, "Light", 300, 700),
          master(700, "Bold", 500, 900),
        ])
      );
      face = harfBuzzReader.open(built.bytes);
    }, BUILD_TIMEOUT);

    it("interpolates a source glyph that every master redrew", () => {
      const o = (weight: number) =>
        face.glyph(glyphOf(face, "o"), { wght: weight });
      const xs = (weight: number) =>
        o(weight)
          .outline.contours.flatMap((contour) => [
            contour.start,
            ...contour.segments.map((segment) => segment.to),
          ])
          .map((point) => point.x);
      expect(o(300).outline.contours).toHaveLength(1);
      expect(Math.max(...xs(300))).toBe(350);
      expect(Math.max(...xs(500))).toBe(450);
      expect(Math.max(...xs(700))).toBe(550);
      expect(furthestFromHalfway(o(500), o(300), o(700))).toBeLessThanOrEqual(
        ROUNDING
      );
    });

    it("interpolates an advance that every master changed", () => {
      const n = (weight: number) =>
        face.glyph(glyphOf(face, "n"), { wght: weight });
      expect([300, 500, 700].map((weight) => n(weight).advance)).toEqual([
        700, 800, 900,
      ]);
      expect(n(700).outline.contours).toHaveLength(
        sofiaFace.glyph(glyphOf(sofiaFace, "n")).outline.contours.length
      );
    });

    it("applies the masters' feature code at every weight", () => {
      const wedge = glyphOf(face, "\u{e000}");
      for (const weight of [300, 500, 700]) {
        const options = { location: { wght: weight } };
        expect(face.shape("x", options).glyphs[0]?.glyphId).toBe(
          glyphOf(face, "x")
        );
        const [swapped] = face.shape("x", {
          ...options,
          features: { ss20: true },
        }).glyphs;
        expect(swapped?.glyphId).toBe(wedge);
        expect(swapped?.xAdvance).toBe(wedgeWidthAt(weight) + 200);
      }
      expect(face.description.layout.substitution).toEqual(
        [...sofiaFace.description.layout.substitution, "ss20"].sort()
      );
    });

    it("keeps the source's own ligatures and kerning beside the new feature", () => {
      const options = { location: { wght: 500 } };
      expect(face.shape("ff", options).glyphs).toHaveLength(1);
      const [kerned] = face.shape("AV", options).glyphs;
      expect(kerned?.xAdvance).toBeLessThan(
        face.glyph(glyphOf(face, "A"), options.location).advance
      );
      expect(face.description.layout.positioning).toEqual(
        sofiaFace.description.layout.positioning
      );
    });

    it("passes the engine's validation", async () => {
      expect((await builder.validate(built.bytes)).issues).toEqual([]);
      expect(built.glyphCount).toBe(sofiaFace.description.glyphCount + 1);
    });
  });

  describe("masters that do not match", () => {
    const light = wedgeMaster(300, "Light");
    const bold = wedgeMaster(700, "Bold");

    it("names the glyph whose contours differ between masters", async () => {
      const split = masterAt(700, "Bold", {
        added: [
          addedWedge(450, {
            outline: {
              contours: [
                ...addedWedge(450).outline.contours,
                ...SQUARE.contours,
              ],
            },
          }),
        ],
      });
      const error = await refusal(variableRequestFor(sofia, [light, split]));
      expect(error).toBeInstanceOf(BuildError);
      expect(error.message).toBe(
        "The glyph wedge cannot interpolate: it has 1 contours in the Light master and 2 in the Bold master. Draw it with the same contours and points in every master."
      );
    });

    it("names the glyph whose points differ between masters", async () => {
      const square = masterAt(700, "Bold", {
        added: [addedWedge(450, { outline: SQUARE })],
      });
      const error = await refusal(variableRequestFor(sofia, [light, square]));
      expect(error.message).toBe(
        "The glyph wedge cannot interpolate: it has 2 segments in contour 1 in the Light master and 3 in the Bold master. Draw it with the same contours and points in every master."
      );
    });

    it("names the glyph drawn with a curve where another master has a line", async () => {
      const [contour] = addedWedge(450).outline.contours;
      const rounded = masterAt(700, "Bold", {
        added: [
          addedWedge(450, {
            outline: {
              contours: [
                {
                  segments: [
                    { kind: "line", to: { x: 325, y: 700 } },
                    {
                      control: { x: 600, y: 300 },
                      kind: "quadratic",
                      to: { x: 550, y: 0 },
                    },
                  ],
                  start: contour?.start ?? { x: 100, y: 0 },
                },
              ],
            },
          }),
        ],
      });
      const error = await refusal(variableRequestFor(sofia, [light, rounded]));
      expect(error.message).toBe(
        "The glyph wedge cannot interpolate: it has a line in contour 1 in the Light master where the Bold master has a quadratic curve. Draw it with the same contours and points in every master."
      );
    });

    it("names a glyph that one master lacks", async () => {
      const bare = masterAt(700, "Bold");
      const error = await refusal(variableRequestFor(sofia, [light, bare]));
      expect(error.message).toBe(
        "The glyph wedge is in the Light master and not in the Bold master. Add it to every master, or remove it."
      );
      const other = await refusal(variableRequestFor(sofia, [bare, light]));
      expect(other.message).toContain("The glyph wedge is in the Light master");
    });

    it("refuses a glyph mapped to different characters", async () => {
      const remapped = masterAt(700, "Bold", {
        added: [addedWedge(450, { characters: [BLOB_CHARACTER] })],
      });
      const error = await refusal(variableRequestFor(sofia, [light, remapped]));
      expect(error.message).toBe(
        "The glyph wedge maps different characters in the Light master and the Bold master. Map it to the same characters in every master."
      );
    });

    it("refuses masters with different feature code", async () => {
      const featured = {
        ...bold,
        featureCode: ["feature ss20 { sub a by wedge; } ss20;"],
      };
      const error = await refusal(variableRequestFor(sofia, [light, featured]));
      expect(error.message).toBe(
        "The Light master and the Bold master carry different feature code. A variable font has one set of layout rules, so give every master the same feature code."
      );
    });

    it(
      "names a source glyph that was redrawn in one master only",
      async () => {
        const redrawn = masterAt(700, "Bold", {
          overrides: new Map([
            [glyphOf(sofiaFace, "a"), { outline: TRIANGLE }],
          ]),
        });
        const error = await refusal(
          variableRequestFor(sofia, [masterAt(300, "Light"), redrawn])
        );
        expect(error).toBeInstanceOf(BuildError);
        expect(error.message).toMatch(REDRAWN_IN_ONE_MASTER);
      },
      BUILD_TIMEOUT
    );
  });

  describe("masters that are not laid out along one axis", () => {
    it("refuses a single master", async () => {
      const error = await refusal(
        variableRequestFor(sofia, [wedgeMaster(300, "Light")])
      );
      expect(error.message).toBe(
        "A variable font needs at least two masters. Pin another instance."
      );
    });

    it("refuses two masters at one location", async () => {
      const error = await refusal(
        variableRequestFor(sofia, [
          wedgeMaster(300, "Light"),
          wedgeMaster(300, "Thin"),
        ])
      );
      expect(error.message).toBe(
        "The Light master and the Thin master are both at wght 300. Give each master a place of its own on the axis."
      );
    });

    it("refuses masters that differ on two axes", async () => {
      const error = await refusal(
        variableRequestFor(fontBytes("devanagari"), [
          masterAt(400, "Regular", { location: { wdth: 100, wght: 400 } }),
          masterAt(700, "Condensed Bold", {
            location: { wdth: 75, wght: 700 },
          }),
        ])
      );
      expect(error.message).toBe(
        "The masters differ on more than one axis (wght, wdth). Pin them along one axis and keep the others the same."
      );
    });

    it("refuses a source that is not variable", async () => {
      const error = await refusal(
        variableRequestFor(fontBytes("lato"), [
          wedgeMaster(300, "Light"),
          wedgeMaster(700, "Bold"),
        ])
      );
      expect(error.message).toBe(
        "The source font is not variable. A variable font is rebuilt from pinned instances of a variable font."
      );
    });

    it("refuses a file that is not a font", async () => {
      const error = await refusal(
        variableRequestFor(new Uint8Array([1, 2, 3, 4]), [
          wedgeMaster(300, "Light"),
          wedgeMaster(700, "Bold"),
        ])
      );
      expect(error).toBeInstanceOf(BuildError);
      expect(error.message).toContain(
        "The source file does not open as a font"
      );
    });
  });

  describe("a source with two axes", () => {
    it(
      "rebuilds one axis and keeps the other where the masters were pinned",
      async () => {
        const devanagari = fontBytes("devanagari");
        const source = harfBuzzReader.open(devanagari);
        const at = (weight: number, styleName: string) =>
          masterAt(weight, styleName, {
            added: [addedWedge(wedgeWidthAt(weight))],
            location: { wdth: 75, wght: weight },
          });
        const built = await builder.buildVariable(
          variableRequestFor(
            devanagari,
            [at(500, "Condensed Medium"), at(700, "Condensed Bold")],
            { familyName: "Atlas Devanagari" }
          )
        );
        console.info(
          "Two masters of Noto Sans Devanagari in Node (ms):",
          built.timings
        );
        const face = harfBuzzReader.open(built.bytes);
        expect(face.description.axes.map((axis) => axis.tag)).toEqual(["wght"]);
        // The source's default, 400, has no master, so the nearest one becomes the default.
        expect(built.axis).toMatchObject({ default: 500, max: 700, min: 500 });
        expect(face.description.styleName).toBe("Condensed Medium");
        const ka = (weight: number) =>
          face.glyph(glyphOf(face, "क"), { wght: weight });
        const sourceKa = (weight: number) =>
          source.glyph(glyphOf(source, "क"), { wdth: 75, wght: weight });
        expect(furthestApart(ka(500), sourceKa(500))).toBeLessThanOrEqual(
          ROUNDING
        );
        expect(furthestApart(ka(700), sourceKa(700))).toBeLessThanOrEqual(
          ROUNDING
        );
        expect(face.shape("क्ष").glyphs).toHaveLength(1);
        expect(
          face.glyph(glyphOf(face, "\u{e000}"), { wght: 600 }).advance
        ).toBe(600);
        expect((await builder.validate(built.bytes)).issues).toEqual([]);
      },
      BUILD_TIMEOUT
    );
  });
});
