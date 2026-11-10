/**
 * What Coverage can offer for the writing system on screen, decided from
 * the face and its coverage alone: whether a script extension on offer suits
 * the face, and how many characters are left to generate.
 */
import { type Face, isEditable } from "~/typeface/face";
import type { CharacterStatus } from "~/unicode/coverage";

/** How a face stands with the characters of a script extension plan. */
export type ExtensionStanding =
  /** The face has none of them, and can take the extension. */
  | { readonly kind: "lacking" }
  /** The project added some or all of them to the face. */
  | { readonly kind: "added"; readonly held: number }
  /** The extension is not for this face, so Coverage does not offer it. */
  | { readonly kind: "not-offered" };

/**
 * An extension adds glyphs for characters a static face lacks. A face whose
 * source font already has one of them, a variable face and a pinned instance
 * are not offered it here; the extension's own place gives the reason.
 */
export const extensionStanding = (
  face: Face,
  characters: readonly number[],
  classify: (codePoint: number) => CharacterStatus
): ExtensionStanding => {
  const statuses = characters.map(classify);
  if (
    !isEditable(face) ||
    face.pinned ||
    statuses.some((status) => status === "source" || status === "edited")
  ) {
    return { kind: "not-offered" };
  }
  const held = statuses.filter((status) => status === "added").length;
  return held > 0 ? { held, kind: "added" } : { kind: "lacking" };
};
