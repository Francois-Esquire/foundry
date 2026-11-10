import type { OpenFace } from "~/typeface/reading";

/**
 * A face that answers as if it lacked some characters. A holdout test hides
 * the characters under test this way, so nothing that plans or draws them can
 * read the face's own answer. The face underneath stays open: it belongs to
 * the workspace, and closing this view does nothing.
 */
export const withoutCharacters = (
  face: OpenFace,
  hidden: readonly number[]
): OpenFace => {
  if (hidden.length === 0) {
    return face;
  }
  const lacking = new Set(hidden);
  return {
    characters: () =>
      face.characters().filter((character) => !lacking.has(character)),
    charactersForGlyph: (glyphId) =>
      face
        .charactersForGlyph(glyphId)
        .filter((character) => !lacking.has(character)),
    close: () => undefined,
    description: face.description,
    glyph: (glyphId, location) => face.glyph(glyphId, location),
    glyphForCharacter: (character) =>
      lacking.has(character) ? undefined : face.glyphForCharacter(character),
    glyphName: (glyphId) => face.glyphName(glyphId),
    shape: (text, options) => face.shape(text, options),
  };
};
