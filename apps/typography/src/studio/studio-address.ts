/** The Studio's place in the address bar: "#/studio/<face>/<glyph>". */
import type { GlyphRef } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import { glyphAddress, parseGlyphAddress } from "./glyph-finding";

export interface StudioAddress {
  readonly faceId?: FaceId;
  readonly glyph?: GlyphRef;
}

/** Reads the path below "#/studio". Either part may be absent or unreadable. */
export const readStudioPath = (path: readonly string[]): StudioAddress => {
  const [faceId, glyph] = path;
  return {
    faceId,
    glyph: glyph === undefined ? undefined : parseGlyphAddress(glyph),
  };
};

/** The hash that opens a face, and a glyph in it, in the Studio. */
export const studioHash = (faceId?: FaceId, glyph?: GlyphRef) =>
  ["#", "studio", faceId, glyph && glyphAddress(glyph)]
    .filter((part) => part !== undefined)
    .map((part, index) => (index === 0 ? part : encodeURIComponent(part)))
    .join("/");

/** Moves the Studio to another face or glyph. The shell follows the address. */
export const openInStudio = (faceId: FaceId, glyph?: GlyphRef) => {
  window.location.hash = studioHash(faceId, glyph);
};
