/**
 * Names for reconstructed glyphs in a target face. A candidate that takes a
 * source glyph's name is refused when it is accepted, so a name is checked
 * against the face first. A character the face already draws is redrawn,
 * not added a second time.
 */

import { glyphNameFor } from "~/generation/plan/target";
import { type GlyphRef, sourceGlyph } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import type { OpenFace } from "~/typeface/reading";

/** The face the candidates are proposed for. */
export interface TargetFace {
  /** The opened face, when it is at hand. Without it no name can be checked. */
  readonly face?: OpenFace;
  readonly faceId: FaceId;
}

export interface GlyphNaming {
  readonly name: string;
  /** Set when the target face already has a glyph for the character. */
  readonly replaces?: GlyphRef;
}

const SUFFIX = "reconstructed";

/** Names each character's glyph so that it collides with nothing in the target face. */
export const namingFor = (
  target: TargetFace
): ((character: number) => GlyphNaming) => {
  const taken = new Set<string>();
  const { face } = target;
  if (face) {
    for (let glyphId = 0; glyphId < face.description.glyphCount; glyphId += 1) {
      taken.add(face.glyphName(glyphId));
    }
  }
  return (character) => {
    const glyphId = face?.glyphForCharacter(character);
    const base = glyphNameFor(character);
    let name = base;
    for (let attempt = 1; taken.has(name); attempt += 1) {
      name = `${base}.${SUFFIX}${attempt === 1 ? "" : attempt}`;
    }
    return {
      name,
      replaces: glyphId === undefined ? undefined : sourceGlyph(glyphId),
    };
  };
};
