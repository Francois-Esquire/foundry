import type { BuildRequest } from "~/packaging/building";
import type { OpenFace } from "~/typeface/reading";

/** A request that changes nothing, to spread over. */
export const requestFor = (
  source: Uint8Array,
  changes: Partial<BuildRequest> = {}
): BuildRequest => ({
  added: [],
  faceIndex: 0,
  featureCode: [],
  overrides: new Map(),
  source,
  ...changes,
});

export const charactersOf = (text: string) =>
  [...text].map((character) => character.codePointAt(0) ?? 0);

/** The glyph a character maps to. Throws when the face does not map it. */
export const glyphOf = (face: OpenFace, character: string) => {
  const glyph = face.glyphForCharacter(character.codePointAt(0) ?? 0);
  if (glyph === undefined) {
    throw new Error(`The face does not map ${character}.`);
  }
  return glyph;
};

export const glyphCountOf = (face: OpenFace, text: string) =>
  face.shape(text).glyphs.length;

/** How far the pen moves after the first glyph of a text, kerning included. */
export const firstAdvanceOf = (face: OpenFace, text: string) =>
  face.shape(text).glyphs[0]?.xAdvance ?? 0;
