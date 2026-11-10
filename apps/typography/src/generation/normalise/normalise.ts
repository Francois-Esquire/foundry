/**
 * Normalise: brings shapes extracted from a sheet into font units. The scale
 * comes from the lines the height model says the glyphs stand between, so
 * the sheet as a whole is fitted once and its glyphs keep their relative size.
 */
import {
  type Outline,
  outlineBounds,
  transformOutline,
} from "~/typeface/outline";
import type { GlyphDraft } from "../draft";
import type { ExtractedGlyph, SheetExtraction } from "../extraction/extraction";
import type { GlyphTarget } from "../plan/target";
import { type SheetLayout, sheetHeight } from "../sheet/layout";
import { headAndFoot, median } from "../style/measure";
import type { StyleReference } from "../style/reference";
import { cleanOutline, debrisArea } from "./clean";
import type { HeightModel, HeightZone } from "./height-model";
import { spaceGlyph } from "./spacing";

/** How a sheet's pixels map to font units. */
export interface SheetFit {
  /** What the scale was taken from: glyphs with known lines, or the layout that was asked for. */
  readonly basis: "height-model" | "layout";
  /** For each row, how far its glyphs move up, in font units, to stand on their lines. */
  readonly rowShifts: readonly number[];
  readonly unitsPerPixel: number;
}

export interface Normalisation {
  readonly drafts: readonly GlyphDraft[];
  readonly fit: SheetFit;
}

interface Measured {
  readonly bottom: number;
  /** The line the foot should reach, lowered by the overshoot when the foot is round. */
  readonly foot?: number;
  readonly glyph: ExtractedGlyph;
  /** The line the head should reach, raised by the overshoot when the head is round. */
  readonly head?: number;
  readonly top: number;
}

const measure = (
  extraction: SheetExtraction,
  zones: ReadonlyMap<string, HeightZone>,
  overshoot: number
): Measured[] =>
  extraction.glyphs.flatMap((glyph) => {
    const bounds = outlineBounds(glyph.outline);
    if (!bounds) {
      return [];
    }
    const zone = zones.get(glyph.key);
    const ends = headAndFoot(glyph.outline);
    const reach = (line: number | undefined, round: boolean, sign: number) =>
      line === undefined ? undefined : line + (round ? sign * overshoot : 0);
    return [
      {
        bottom: bounds.yMin,
        foot: reach(zone?.bottom, ends?.foot === "round", -1),
        glyph,
        head: reach(zone?.top, ends?.head === "round", 1),
        top: bounds.yMax,
      },
    ];
  });

/** How far a row must move so its glyphs' feet and heads land on their lines. */
const rowShift = (
  inRow: readonly Measured[],
  unitsPerPixel: number
): number => {
  const feet = inRow.flatMap(({ bottom, foot }) =>
    foot === undefined ? [] : [foot - bottom * unitsPerPixel]
  );
  const heads = inRow.flatMap(({ head, top }) =>
    head === undefined ? [] : [head - top * unitsPerPixel]
  );
  return median(feet) ?? median(heads) ?? 0;
};

/**
 * Fits a sheet to font units. The scale is the middle ratio between the
 * height each glyph should have and the height its ink has, where a round
 * head or foot is expected to overshoot its line as the face's own do. When
 * no glyph on the sheet has two known lines, the scale falls back to the
 * layout.
 */
const fitSheet = (
  extraction: SheetExtraction,
  layout: SheetLayout,
  zones: ReadonlyMap<string, HeightZone>,
  style: StyleReference
): SheetFit => {
  const measured = measure(extraction, zones, style.overshoot);
  const ratios = measured.flatMap(({ bottom, foot, head, top }) =>
    head !== undefined && foot !== undefined && top > bottom
      ? [(head - foot) / (top - bottom)]
      : []
  );
  const emPixels =
    (layout.emSize * extraction.size.height) / sheetHeight(layout);
  const unitsPerPixel = median(ratios) ?? style.unitsPerEm / emPixels;
  return {
    basis: ratios.length > 0 ? "height-model" : "layout",
    rowShifts: extraction.rows.map((_, row) =>
      rowShift(
        measured.filter(({ glyph }) => glyph.row === row),
        unitsPerPixel
      )
    ),
    unitsPerPixel,
  };
};

const toFontUnits = (glyph: ExtractedGlyph, fit: SheetFit): Outline =>
  transformOutline(glyph.outline, {
    dx: 0,
    dy: fit.rowShifts[glyph.row] ?? 0,
    xx: fit.unitsPerPixel,
    xy: 0,
    yx: 0,
    yy: fit.unitsPerPixel,
  });

const ROUTES: Readonly<Record<ExtractedGlyph["source"], string>> = {
  traced: "traced from the pixels of",
  vector: "taken from the vector shapes of",
};

/** One extracted glyph in font units: scaled, set on its baseline, spaced and cleaned. */
const normaliseGlyph = (
  glyph: ExtractedGlyph,
  fit: SheetFit,
  style: StyleReference
): GlyphDraft => {
  const spaced = spaceGlyph(toFontUnits(glyph, fit), style);
  const cleaned = cleanOutline(spaced.outline, {
    minimumArea: debrisArea(style.stems.vertical, style.unitsPerEm),
  });
  return {
    advance: spaced.advance,
    key: glyph.key,
    madeBy: `Extracted: ${ROUTES[glyph.source]} sheet cell row ${glyph.row + 1}, column ${glyph.column + 1}, at ${fit.unitsPerPixel.toFixed(2)} units per pixel from the ${fit.basis === "layout" ? "sheet layout" : "height model"}; spaced as a ${spaced.edges.left} left edge and a ${spaced.edges.right} right edge.`,
    outline: cleaned.outline,
    weaknesses: [],
  };
};

/** Normalises every glyph extracted from a sheet. */
export const normaliseSheet = (
  extraction: SheetExtraction,
  layout: SheetLayout,
  targets: readonly GlyphTarget[],
  style: StyleReference,
  heightModel: HeightModel
): Normalisation => {
  const zones = new Map(
    targets.map((target) => [target.key, heightModel(target)])
  );
  const fit = fitSheet(extraction, layout, zones, style);
  return {
    drafts: extraction.glyphs.map((glyph) => normaliseGlyph(glyph, fit, style)),
    fit,
  };
};
