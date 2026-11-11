import { beforeAll, describe, expect, it } from "vitest";
import { shapeAgreement } from "~/generation/evaluation/agreement";
import type { SheetExtraction } from "~/generation/extraction/extraction";
import { extractInkSheet } from "~/generation/extraction/raster-sheet";
import { extractSvgSheet } from "~/generation/extraction/svg-sheet";
import { latinHeightModel } from "~/generation/normalise/height-model";
import { normaliseSheet } from "~/generation/normalise/normalise";
import { planCharacters } from "~/generation/plan/plan";
import { targetKeyFor } from "~/generation/plan/target";
import { inkArea } from "~/generation/raster/bitmap";
import { frameAround, rasterizeOutline } from "~/generation/raster/rasterize";
import { drawSheet, sheetToSvg } from "~/generation/sheet/drawing";
import { layoutSheet } from "~/generation/sheet/layout";
import { analyseStyle } from "~/generation/style/reference";
import {
  type Outline,
  outlineBounds,
  transformOutline,
} from "~/typeface/outline";
import type { GlyphShape } from "~/typeface/reading";
import { fixtureFace } from "../helpers/faces";
import { withoutCharacters } from "./helpers/faces";
import { glyphOf } from "./helpers/glyphs";
import { unevenSheet } from "./helpers/sheets";

const lato = fixtureFace("lato");
const UNITS_PER_EM = 2000;

const boundsOf = (outline: Outline) => {
  const bounds = outlineBounds(outline);
  if (!bounds) {
    throw new Error("Expected a drawn outline.");
  }
  return bounds;
};

/** An extracted outline, in sheet pixels from its own left edge, back in font units. */
const inFontUnits = (outline: Outline, unitsPerPixel: number): Outline =>
  transformOutline(outline, {
    dx: 0,
    dy: 0,
    xx: unitsPerPixel,
    xy: 0,
    yx: 0,
    yy: unitsPerPixel,
  });

describe("extraction from a sheet that breaks its grid", () => {
  const characters = ["a", "g", "O", "é", "n", undefined, "x", "p", "H"];
  const sheet = unevenSheet(lato, characters, (character) =>
    glyphOf(lato, character)
  );
  let extraction: SheetExtraction;

  beforeAll(() => {
    extraction = extractInkSheet(sheet.ink, sheet.layout);
  });

  const found = (key: string) => {
    const glyph = extraction.glyphs.find((item) => item.key === key);
    if (!glyph) {
      throw new Error(`No glyph was extracted for ${key}.`);
    }
    return glyph;
  };

  it("finds every drawn cell in its row and column despite uneven cells", () => {
    expect(
      extraction.glyphs.map((glyph) => [glyph.key, glyph.row, glyph.column])
    ).toEqual([
      ["a", 0, 0],
      ["g", 0, 1],
      ["O", 0, 2],
      ["é", 1, 0],
      ["n", 1, 1],
      ["x", 2, 0],
      ["p", 2, 1],
      ["H", 2, 2],
    ]);
  });

  it("reports the empty cell, and nothing merged or extra", () => {
    expect(extraction.report.empty).toEqual(["empty-5"]);
    expect(extraction.report.merged).toEqual([]);
    expect(extraction.report.extra).toEqual([]);
  });

  it("sets label text and ruled lines aside", () => {
    // Eight one-letter labels and the five letters of "empty". The accent on
    // the é label is small enough to go as a speck.
    expect(extraction.report.labels).toBe(13);
    // Three top rules, three baselines and three cell edges.
    expect(extraction.report.guides).toBe(9);
  });

  it("measures and undoes the rotation", () => {
    expect(extraction.rotation).toBeCloseTo(sheet.rotation, 1);
  });

  it("keeps each glyph's size and position from its row's baseline", () => {
    const pixel = 1 / sheet.unitsPerPixel;
    const x = boundsOf(found("x").outline);
    expect(Math.abs(x.yMin)).toBeLessThan(1);
    expect(Math.abs(x.yMax - 1013 * pixel)).toBeLessThan(1);
    const capital = boundsOf(found("H").outline);
    expect(Math.abs(capital.yMax - 1433 * pixel)).toBeLessThan(1);
    const descender = boundsOf(found("p").outline);
    expect(Math.abs(descender.yMin - -343 * pixel)).toBeLessThan(1);
    const accented = boundsOf(found("é").outline);
    expect(Math.abs(accented.yMax - 1449 * pixel)).toBeLessThan(1);
  });

  it("recovers shapes that agree with the glyphs that were drawn", () => {
    for (const character of characters) {
      if (!character) {
        continue;
      }
      const source = glyphOf(lato, character).outline;
      const { aligned } = shapeAgreement(
        inFontUnits(found(character).outline, sheet.unitsPerPixel),
        source,
        UNITS_PER_EM
      );
      // A 150-pixel em puts a stem at about 14 pixels, so a half-pixel edge
      // error on both sides of a stroke already costs about 7%.
      expect(aligned, character).toBeGreaterThan(0.9);
    }
  });

  it("normalises onto the baseline and the x-height", () => {
    const style = analyseStyle(lato);
    const wanted = characters
      .filter((character) => character !== undefined)
      .map((character) => character.codePointAt(0) ?? 0);
    // Plan against a face that lacks these characters, as a real request would.
    const { targets } = planCharacters(withoutCharacters(lato, wanted), wanted);
    const keyed = targets.map((target) => ({
      ...target,
      key: target.text,
    }));
    const { drafts, fit } = normaliseSheet(
      extraction,
      sheet.layout,
      keyed,
      style,
      latinHeightModel(style)
    );
    expect(fit.basis).toBe("height-model");
    expect(fit.unitsPerPixel).toBeCloseTo(sheet.unitsPerPixel, 0);
    const draft = drafts.find((item) => item.key === "x");
    const bounds = boundsOf(draft?.outline ?? { contours: [] });
    // One sheet pixel is 13.3 units, so 20 units is a pixel and a half.
    expect(Math.abs(bounds.yMin)).toBeLessThan(20);
    expect(Math.abs(bounds.yMax - style.metrics.xHeight)).toBeLessThan(20);
    const descending = drafts.find((item) => item.key === "p");
    const low = boundsOf(descending?.outline ?? { contours: [] });
    expect(Math.abs(low.yMin - style.metrics.descender)).toBeLessThan(20);
    // Spaced from the face's model: x has open sides, so small bearings.
    expect(bounds.xMin).toBe(Math.round(style.sidebearings.diagonal));
    expect(Number.isInteger(draft?.advance)).toBe(true);
  });
});

describe("extraction from one SVG holding several glyphs", () => {
  const characters = [..."aOgéx&"];
  const glyphs = new Map<string, GlyphShape>(
    characters.map((character) => [
      targetKeyFor(character.codePointAt(0) ?? 0),
      glyphOf(lato, character),
    ])
  );
  const layout = layoutSheet(
    characters.map((character) => ({
      key: targetKeyFor(character.codePointAt(0) ?? 0),
      label: character,
    })),
    { maxSize: 900 }
  );
  const svg = sheetToSvg(
    drawSheet(layout, glyphs, { guides: true, unitsPerEm: UNITS_PER_EM })
  );

  it("keeps the vector shapes of each glyph", () => {
    const extraction = extractSvgSheet(svg, layout);
    expect(extraction.glyphs.map((glyph) => glyph.key)).toEqual(
      layout.cells.map((cell) => cell.key)
    );
    expect(extraction.glyphs.every((glyph) => glyph.source === "vector")).toBe(
      true
    );
    const unitsPerPixel =
      (UNITS_PER_EM / layout.emSize) * (900 / extraction.size.width);
    for (const [index, glyph] of extraction.glyphs.entries()) {
      const source = glyphOf(lato, characters[index] ?? "").outline;
      const { aligned } = shapeAgreement(
        inFontUnits(glyph.outline, unitsPerPixel),
        source,
        UNITS_PER_EM
      );
      // The curves are the model's own, so only rasterising them differs.
      expect(aligned, characters[index]).toBeGreaterThan(0.98);
    }
  });

  const pair = {
    ...layoutSheet(
      [
        { key: "ring", label: "O" },
        { key: "bar", label: "I" },
      ],
      { maxSize: 400 }
    ),
    cellHeight: 200,
    cellWidth: 200,
  };

  it("cuts a counter painted in white over black out of the ink", () => {
    // Real vector models draw counters this way: a light shape on a dark one.
    const extraction = extractSvgSheet(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
        <path fill="#fefffe" d="M0 0 L0 200 L400 200 L400 0 Z"/>
        <circle cx="100" cy="100" r="60" fill="#000"/>
        <circle cx="100" cy="100" r="30" fill="#fefffe"/>
        <rect x="260" y="40" width="40" height="120" fill="#010101"/>
        <text x="10" y="20">O I</text>
      </svg>`,
      pair
    );
    const [ring, bar] = extraction.glyphs;
    expect(ring?.source).toBe("vector");
    expect(ring?.outline.contours).toHaveLength(2);
    // The ring's ink is the disc less the hole, at 1024 / 400 pixels a unit.
    const scale = 1024 / 400;
    const ink = inkArea(
      rasterizeOutline(
        ring?.outline ?? { contours: [] },
        frameAround({ xMax: 320, xMin: -5, yMax: 320, yMin: -5 }, 1)
      )
    );
    expect(ink / scale ** 2).toBeCloseTo(Math.PI * (60 ** 2 - 30 ** 2), -2);
    expect(bar?.source).toBe("vector");
    expect(extraction.report.notes.join(" ")).toContain("Text");
  });

  it("leaves a counter alone when a light shape is painted inside it", () => {
    // The ring already has its hole. A light dot inside the hole is on paper.
    const extraction = extractSvgSheet(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
        <rect width="400" height="200" fill="#fff"/>
        <path d="M40 100 a60 60 0 1 0 120 0 a60 60 0 1 0 -120 0 Z M70 100 a30 30 0 1 1 60 0 a30 30 0 1 1 -60 0 Z"/>
        <circle cx="100" cy="100" r="10" fill="#fff"/>
        <rect x="260" y="40" width="40" height="120"/>
      </svg>`,
      pair
    );
    const [ring] = extraction.glyphs;
    expect(ring?.source).toBe("vector");
    expect(ring?.outline.contours).toHaveLength(2);
    const scale = 1024 / 400;
    const ink = inkArea(
      rasterizeOutline(
        ring?.outline ?? { contours: [] },
        frameAround({ xMax: 320, xMin: -5, yMax: 320, yMin: -5 }, 1)
      )
    );
    expect(ink / scale ** 2).toBeCloseTo(Math.PI * (60 ** 2 - 30 ** 2), -2);
  });

  it("traces a glyph when a light shape cuts across the edge of its ink", () => {
    const extraction = extractSvgSheet(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
        <rect width="400" height="200" fill="#fff"/>
        <circle cx="100" cy="100" r="60" fill="#000"/>
        <rect x="90" y="20" width="20" height="100" fill="#fff"/>
        <rect x="260" y="40" width="40" height="120"/>
      </svg>`,
      pair
    );
    const [notched, bar] = extraction.glyphs;
    expect(notched?.source).toBe("traced");
    expect(notched?.outline.contours).toHaveLength(1);
    expect(bar?.source).toBe("vector");
    expect(extraction.report.notes.join(" ")).toContain("traced");
  });
});
