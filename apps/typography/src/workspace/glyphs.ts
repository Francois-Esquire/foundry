/** A face's glyphs as the project currently has them: the source font plus the working face. */
import {
  addedGlyph,
  type GlyphRef,
  sourceGlyph,
  type WorkingFace,
} from "~/typeface/changes";
import type { Provenance } from "~/typeface/provenance";
import type { OpenFace } from "~/typeface/reading";

export interface GlyphEntry {
  /** Characters that currently map to this glyph. Empty for ligatures and alternates. */
  readonly characters: readonly number[];
  /** True when the glyph differs from the source font: redrawn, respaced or added. */
  readonly edited: boolean;
  readonly name: string;
  /** Where an added glyph came from. Absent for source glyphs. */
  readonly provenance?: Provenance;
  readonly ref: GlyphRef;
}

/** The glyph a character maps to before shaping. An added glyph wins over the source font's. */
export const glyphForCharacter = (
  working: WorkingFace,
  source: OpenFace,
  codePoint: number
): GlyphRef | undefined => {
  const key = working.characters.get(codePoint);
  if (key !== undefined) {
    return addedGlyph(key);
  }
  const glyphId = source.glyphForCharacter(codePoint);
  return glyphId === undefined ? undefined : sourceGlyph(glyphId);
};

/** Every glyph in the face: source glyphs by glyph id, then added glyphs in the order added. */
export const listGlyphs = (
  working: WorkingFace,
  source: OpenFace
): GlyphEntry[] => {
  const entries: GlyphEntry[] = [];
  for (let glyphId = 0; glyphId < source.description.glyphCount; glyphId += 1) {
    const characters = source.charactersForGlyph(glyphId);
    entries.push({
      characters: characters.some((code) => working.characters.has(code))
        ? characters.filter((code) => !working.characters.has(code))
        : characters,
      edited: working.overrides.has(glyphId),
      name: source.glyphName(glyphId),
      ref: sourceGlyph(glyphId),
    });
  }
  for (const glyph of working.added) {
    entries.push({
      characters: glyph.characters.filter(
        (code) => working.characters.get(code) === glyph.key
      ),
      edited: true,
      name: glyph.name,
      provenance: glyph.provenance,
      ref: addedGlyph(glyph.key),
    });
  }
  return entries;
};
