import { describe, expect, it } from "vitest";
import {
  latinHeightModel,
  uniformHeightModel,
} from "~/generation/normalise/height-model";
import { planCharacters, planForm, planOblique } from "~/generation/plan/plan";
import { inkBox } from "~/generation/raster/bitmap";
import { analyseStyle, chooseSample } from "~/generation/style/reference";
import { renderReferenceSheet } from "~/generation/style/reference-sheet";
import { parseSvg } from "~/generation/vector/svg/document";
import { outlineBounds } from "~/typeface/outline";
import { fixtureFace } from "../helpers/faces";
import { withoutCharacters } from "./helpers/faces";
import { glyphOf } from "./helpers/glyphs";

const lato = fixtureFace("lato");
const code = (character: string) => character.codePointAt(0) ?? 0;

describe("the style reference", () => {
  const style = analyseStyle(lato);

  it("measures vertical metrics from glyphs, not from the font's line-spacing fields", () => {
    expect(style.unitsPerEm).toBe(2000);
    expect(style.metrics).toMatchObject({
      capHeight: 1433,
      sources: {
        ascender: "measured",
        capHeight: "measured",
        descender: "measured",
        xHeight: "measured",
      },
      xHeight: 1013,
    });
    // Lato declares an ascender of 1974 for line spacing. Its l stops at 1473.
    expect(lato.description.metrics.ascender).toBe(1974);
    expect(style.metrics.ascender).toBe(
      outlineBounds(glyphOf(lato, "l").outline)?.yMax
    );
    expect(style.metrics.descender).toBe(-343);
    expect(style.extent).toEqual({ bottom: -426, top: 1974 });
  });

  it("measures stems, contrast, overshoot and slant", () => {
    // The stem of Lato's dotless i is 179 units wide; capitals are a little heavier.
    const stem = outlineBounds(glyphOf(lato, "ı").outline);
    expect(style.stems.vertical).toBeGreaterThan(
      (stem?.xMax ?? 0) - (stem?.xMin ?? 0)
    );
    expect(style.stems.vertical).toBeLessThan(195);
    expect(style.stems.horizontal).toBeLessThan(style.stems.vertical);
    expect(style.contrast).toBeGreaterThan(1.05);
    expect(style.contrast).toBeLessThan(1.4);
    // The o dips 14 units below the baseline and the O 15.
    expect(style.overshoot).toBeCloseTo(14.5);
    expect(style.slant).toBe(0);
  });

  it("measures the slant of a sheared face", () => {
    const upright = glyphOf(lato, "H");
    const lean = Math.tan((10 * Math.PI) / 180);
    const slanted = withoutCharacters(lato, []);
    const sheared = {
      ...slanted,
      glyph: (glyphId: number) => {
        const glyph = lato.glyph(glyphId);
        return {
          advance: glyph.advance,
          outline: {
            contours: glyph.outline.contours.map((contour) => ({
              segments: contour.segments.map((segment) =>
                segment.kind === "line"
                  ? {
                      kind: "line" as const,
                      to: {
                        x: segment.to.x + lean * segment.to.y,
                        y: segment.to.y,
                      },
                    }
                  : segment
              ),
              start: {
                x: contour.start.x + lean * contour.start.y,
                y: contour.start.y,
              },
            })),
          },
        };
      },
    };
    expect(upright.outline.contours).toHaveLength(1);
    expect(
      analyseStyle(sheared, { characters: [..."HIElT"].map(code) }).slant
    ).toBeCloseTo(10, 0);
  });

  it("groups sidebearings by the shape of the edge", () => {
    const { diagonal, round, straight } = style.sidebearings;
    expect(straight).toBeGreaterThan(round);
    expect(round).toBeGreaterThan(diagonal);
    // The n has a straight stem on its left, 141 units in.
    expect(straight).toBeCloseTo(
      outlineBounds(glyphOf(lato, "n").outline)?.xMin ?? 0,
      -1
    );
    expect(style.averageAdvance).toBeGreaterThan(900);
    expect(style.inkDensity.low).toBeLessThan(style.inkDensity.median);
    expect(style.inkDensity.median).toBeLessThan(style.inkDensity.high);
  });

  it("measures a variable face at the location it is asked for", () => {
    const sofia = fixtureFace("sofia");
    const light = analyseStyle(sofia, { location: { wght: 200 } });
    const black = analyseStyle(sofia, { location: { wght: 900 } });
    expect(black.stems.vertical).toBeGreaterThan(2 * light.stems.vertical);
    expect(black.location).toEqual({ wght: 900 });
  });

  it("measures another script by its own letters", () => {
    const devanagari = fixtureFace("devanagari");
    const letters = [0x09_15, 0x09_16, 0x09_17, 0x09_18, 0x09_1a, 0x09_1c];
    const measured = analyseStyle(devanagari, { characters: letters });
    expect(measured.characters).toEqual(letters);
    expect(measured.stems.vertical).toBeGreaterThan(50);
    expect(measured.stems.vertical).toBeLessThan(120);
    // A face with no Latin sample is measured by an even spread of its letters.
    const onlyDevanagari = withoutCharacters(
      devanagari,
      [...devanagari.characters()].filter((character) => character < 0x09_00)
    );
    const sample = chooseSample(onlyDevanagari);
    expect(sample.length).toBeGreaterThan(20);
    expect(sample.every((character) => character >= 0x09_00)).toBe(true);
  });
});

describe("the reference sheet", () => {
  const style = analyseStyle(lato);
  const sheet = renderReferenceSheet(lato, style, {
    characters: [..."HOEBnoedpstv"].map(code),
    maxSize: 800,
  });

  it("lays the chosen glyphs out in a labelled grid", () => {
    expect(sheet.layout.columns).toBe(4);
    expect(sheet.layout.cells.map((cell) => cell.label)).toEqual([
      "U+0048",
      "U+004F",
      "U+0045",
      "U+0042",
      "U+006E",
      "U+006F",
      "U+0065",
      "U+0064",
      "U+0070",
      "U+0073",
      "U+0074",
      "U+0076",
    ]);
    const tones = sheet.drawing.shapes.map((shape) => shape.tone);
    expect(tones.filter((tone) => tone === "glyph")).toHaveLength(12);
    expect(tones.filter((tone) => tone === "label")).toHaveLength(12);
    expect(tones).toContain("guide");
  });

  it("is one drawing in two forms: an SVG string and a bitmap", () => {
    expect(sheet.svg.startsWith("<svg")).toBe(true);
    const document = parseSvg(sheet.svg);
    expect(document.viewBox).toMatchObject({ height: 600, width: 800 });
    // The paper, then every guide, label and glyph as a filled path.
    expect(document.shapes).toHaveLength(1 + sheet.drawing.shapes.length);
    expect(document.defects).toEqual([]);
    expect(sheet.bitmap.width).toBe(800);
    expect(sheet.bitmap.height).toBe(600);
    const ink = inkBox(sheet.bitmap);
    expect(ink?.left).toBeGreaterThan(0);
    expect(ink?.bottom).toBeLessThan(600);
  });
});

describe("planning", () => {
  it("skips characters the face has and gives the rest a recipe where one exists", () => {
    const hidden = withoutCharacters(lato, [code("é"), code("ï")]);
    const plan = planCharacters(hidden, [..."aéï"].map(code));
    expect(plan.present).toEqual([code("a")]);
    expect(plan.targets).toEqual([
      {
        characters: [0xe9],
        key: "u+00e9",
        name: "uni00E9",
        needs: [],
        recipe: { base: 0x65, kind: "composite", marks: [0x03_01] },
        text: "é",
      },
      {
        characters: [0xef],
        key: "u+00ef",
        name: "uni00EF",
        needs: [],
        // The dotless i, because the face has one.
        recipe: { base: 0x01_31, kind: "composite", marks: [0x03_08] },
        text: "ï",
      },
    ]);
  });

  it("plans the parts a composite needs before the composite", () => {
    // Without e, and without either form of the acute, é needs both drawn first.
    const bare = withoutCharacters(lato, [0xe9, 0x65, 0x03_01, 0xb4]);
    const plan = planCharacters(bare, [0xe9]);
    expect(plan.targets.map((target) => [target.key, target.needs])).toEqual([
      ["u+0065", []],
      ["u+0301", []],
      ["u+00e9", ["u+0065", "u+0301"]],
    ]);
    // With no dotless i in the face, the plain i is the base.
    const dotted = withoutCharacters(lato, [0xef, 0x01_31]);
    expect(planCharacters(dotted, [0xef]).targets[0]?.recipe).toMatchObject({
      base: 0x69,
    });
  });

  it("plans redrawings and forms no character maps to", () => {
    const [oblique] = planOblique(lato, [code("H")]).targets;
    expect(oblique?.replaces).toEqual({
      glyphId: lato.glyphForCharacter(code("H")),
      kind: "source",
    });
    expect(planForm("क्ष", "kssa-deva")).toEqual({
      characters: [],
      key: "form:U+0915+U+094D+U+0937",
      name: "kssa-deva",
      needs: [],
      text: "क्ष",
    });
  });

  it("gives each kind of glyph its lines, and takes another script's from outside", () => {
    const style = analyseStyle(lato);
    const model = latinHeightModel(style);
    const zoneOf = (character: string) => {
      const hidden = withoutCharacters(lato, [code(character)]);
      const target = planCharacters(hidden, [code(character)]).targets.at(-1);
      return target && model(target);
    };
    expect(zoneOf("H")).toEqual({ bottom: 0, name: "capital", top: 1433 });
    expect(zoneOf("x")).toEqual({ bottom: 0, name: "lowercase", top: 1013 });
    expect(zoneOf("p")).toMatchObject({ bottom: -343, top: 1013 });
    expect(zoneOf("d")).toMatchObject({ bottom: 0, top: 1473 });
    expect(zoneOf("7")).toMatchObject({ name: "figure", top: 1433 });
    // A mark above frees the top, a cedilla frees the foot.
    expect(zoneOf("é")).toEqual({
      bottom: 0,
      name: "lowercase with a mark",
      top: undefined,
    });
    expect(zoneOf("ç")).toMatchObject({ bottom: undefined, top: 1013 });
    expect(zoneOf("?")).toEqual({
      bottom: undefined,
      name: "punctuation",
      top: undefined,
    });
    const hanging = uniformHeightModel({
      bottom: 0,
      name: "letter",
      top: 1244,
    });
    expect(hanging(planForm("क्ष", "kssa-deva")).top).toBe(1244);
  });
});
