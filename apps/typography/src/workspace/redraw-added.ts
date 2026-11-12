import type { GlyphRef } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import type { Workspace } from "./workspace";

/** Reuses an added glyph when a character is drawn again in the same face. */
export const redrawAdded = <
  T extends {
    readonly characters: readonly number[];
    readonly replaces?: GlyphRef;
  },
>(
  workspace: Pick<Workspace, "glyphForCharacter">,
  faceId: FaceId,
  target: T
): T => {
  const [character] = target.characters;
  if (target.replaces || character === undefined) {
    return target;
  }
  const existing = workspace.glyphForCharacter(faceId, character);
  return existing?.kind === "added"
    ? { ...target, replaces: existing }
    : target;
};
