/**
 * The style reference sheet: a labelled grid of glyphs from the source face.
 * It is what an image or vector model is shown, and the record of what it saw.
 */
import type { AxisLocation } from "~/typeface/face";
import { type Contour, translateOutline } from "~/typeface/outline";
import type { GlyphShape, OpenFace } from "~/typeface/reading";
import { characterLabel, targetKeyFor } from "../plan/target";
import type { Bitmap } from "../raster/bitmap";
import {
  drawSheet,
  type LabelWriter,
  type SheetDrawing,
  sheetToBitmap,
  sheetToSvg,
} from "../sheet/drawing";
import { layoutSheet, type SheetLayout } from "../sheet/layout";
import type { StyleReference } from "./reference";

export interface ReferenceSheet {
  /** The sheet as an ink map, for encoding as an image. */
  readonly bitmap: Bitmap;
  readonly drawing: SheetDrawing;
  readonly layout: SheetLayout;
  readonly svg: string;
}

export interface ReferenceSheetOptions {
  /** The characters to show. The first 25 measured for the style reference when absent. */
  readonly characters?: readonly number[];
  readonly location?: AxisLocation;
  readonly maxSize?: number;
}

const DEFAULT_COUNT = 25;

/**
 * Writes labels with the face's own glyphs, one after another by advance.
 * A label with a character the face lacks is left out.
 */
export const faceLabelWriter =
  (face: OpenFace, location?: AxisLocation): LabelWriter =>
  (text) => {
    const contours: Contour[] = [];
    let pen = 0;
    for (const character of text) {
      const glyphId = face.glyphForCharacter(character.codePointAt(0) ?? 0);
      if (glyphId === undefined) {
        return;
      }
      const glyph = face.glyph(glyphId, location);
      contours.push(...translateOutline(glyph.outline, pen, 0).contours);
      pen += glyph.advance;
    }
    return { advance: pen, outline: { contours } };
  };

/** Renders the reference sheet for a face: its glyphs on ruled baselines, each cell labelled. */
export const renderReferenceSheet = (
  face: OpenFace,
  style: StyleReference,
  options: ReferenceSheetOptions = {}
): ReferenceSheet => {
  const location = options.location ?? style.location;
  const characters = (options.characters ?? style.characters).slice(
    0,
    options.characters ? undefined : DEFAULT_COUNT
  );
  const glyphs = new Map<string, GlyphShape>();
  for (const character of characters) {
    const glyphId = face.glyphForCharacter(character);
    if (glyphId !== undefined) {
      glyphs.set(targetKeyFor(character), face.glyph(glyphId, location));
    }
  }
  const layout = layoutSheet(
    characters
      .filter((character) => glyphs.has(targetKeyFor(character)))
      .map((character) => ({
        key: targetKeyFor(character),
        label: characterLabel(character),
      })),
    { maxSize: options.maxSize }
  );
  const drawing = drawSheet(layout, glyphs, {
    guides: true,
    labels: faceLabelWriter(face, location),
    unitsPerEm: style.unitsPerEm,
  });
  return {
    bitmap: sheetToBitmap(drawing),
    drawing,
    layout,
    svg: sheetToSvg(drawing),
  };
};
