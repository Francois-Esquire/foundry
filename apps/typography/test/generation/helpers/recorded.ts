import { nodeImageCodec } from "~/generation/node-image-codec";
import {
  drawSheet,
  inkToImage,
  sheetToBitmap,
} from "~/generation/sheet/drawing";
import { layoutSheet } from "~/generation/sheet/layout";
import type {
  RecordedOutput,
  RecordedRunManifest,
} from "~/generation/strategies/recorded/manifest";
import type { GlyphShape, OpenFace } from "~/typeface/reading";

/** The grid of the synthetic sheet, as a recorded run's manifest states it. */
const SYNTHETIC_COLUMNS = 3;

/**
 * A sheet drawn by this test from a face's own glyphs, encoded as a PNG. No
 * model made it, and every manifest built on it says so.
 */
export const syntheticSheetPng = async (
  face: OpenFace,
  characters: readonly string[]
): Promise<Uint8Array> => {
  const glyphs = new Map<string, GlyphShape>();
  for (const character of characters) {
    const glyphId = face.glyphForCharacter(character.codePointAt(0) ?? 0);
    if (glyphId !== undefined) {
      glyphs.set(character, face.glyph(glyphId));
    }
  }
  const even = layoutSheet(
    characters.map((character) => ({ key: character, label: character })),
    { maxSize: 900 }
  );
  const layout = { ...even, columns: SYNTHETIC_COLUMNS };
  const drawing = drawSheet(layout, glyphs, {
    guides: true,
    unitsPerEm: face.description.metrics.unitsPerEm,
  });
  return nodeImageCodec.encodePng(inkToImage(sheetToBitmap(drawing)));
};

/**
 * A manifest for the synthetic sheet. Its one output is marked synthetic
 * unless a test overrides that to check how a model's output is attributed.
 */
export const syntheticManifest = (
  characters: readonly string[],
  output: Partial<RecordedOutput> = {}
): RecordedRunManifest => ({
  createdAt: "2026-11-10T09:30:00.000Z",
  id: "synthetic-sheet-1",
  layout: { columns: SYNTHETIC_COLUMNS },
  outputs: [
    {
      file: "sheet.png",
      kind: "sheet-image",
      model: "none",
      prompt: "A sheet drawn by a test from the face's own glyphs.",
      strategy: "image-model",
      synthetic: true,
      ...output,
    },
  ],
  targets: characters,
});
