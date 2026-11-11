import { decorateFace, type OpenFace } from "~/typeface/reading";

/**
 * A face that behaves as if it lacked some characters. A holdout test hides
 * a character this way, asks for it to be generated, and compares the result
 * with the glyph the real face has.
 */
export const withoutCharacters = (
  face: OpenFace,
  hidden: readonly number[]
): OpenFace => {
  const lacking = new Set(hidden);
  return decorateFace(face, {
    characters: () =>
      face.characters().filter((character) => !lacking.has(character)),
    charactersForGlyph: (glyphId) =>
      face
        .charactersForGlyph(glyphId)
        .filter((character) => !lacking.has(character)),
    glyphForCharacter: (character) =>
      lacking.has(character) ? undefined : face.glyphForCharacter(character),
  });
};
