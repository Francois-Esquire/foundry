import type { Face } from "~/typeface/face";
import type { OpenFace } from "~/typeface/reading";

/**
 * A pinned instance read through its variable source. Glyphs and shaping sit
 * at the pinned location unless a call names another one, and the face
 * describes itself as static, under the pinned style name. Closing the view
 * leaves the source face open, because other faces read from it too.
 */
export const pinnedFaceView = (
  source: OpenFace,
  pinned: NonNullable<Face["pinned"]>
): OpenFace => ({
  characters: () => source.characters(),
  charactersForGlyph: (glyphId) => source.charactersForGlyph(glyphId),
  close: () => undefined,
  description: {
    ...source.description,
    axes: [],
    fullName: `${source.description.familyName} ${pinned.styleName}`,
    instances: [],
    styleName: pinned.styleName,
  },
  glyph: (glyphId, location) =>
    source.glyph(glyphId, location ?? pinned.location),
  glyphForCharacter: (codePoint) => source.glyphForCharacter(codePoint),
  glyphName: (glyphId) => source.glyphName(glyphId),
  shape: (text, options) =>
    source.shape(text, {
      ...options,
      location: options?.location ?? pinned.location,
    }),
});
