/** Turning an edited glyph shape into changes, and laying an unrecorded edit over a working face. */
import type { Change, GlyphRef, WorkingFace } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import { type Outline, outlineToPath } from "~/typeface/outline";
import type { GlyphShape } from "~/typeface/reading";

const sameOutline = (a: Outline, b: Outline) =>
  a === b || outlineToPath(a) === outlineToPath(b);

/** The changes that take a glyph from one shape to another. None when nothing differs. */
export const changesBetween = (
  faceId: FaceId,
  glyph: GlyphRef,
  from: GlyphShape,
  to: GlyphShape
): Change[] => {
  const changes: Change[] = [];
  if (!sameOutline(from.outline, to.outline)) {
    changes.push({
      faceId,
      glyph,
      kind: "outline-replaced",
      outline: to.outline,
    });
  }
  if (from.advance !== to.advance) {
    changes.push({
      advance: to.advance,
      faceId,
      glyph,
      kind: "advance-changed",
    });
  }
  return changes;
};

/**
 * A working face with one glyph drawn as given, for showing an edit that is
 * under way and not yet a revision.
 */
export const withGlyphShape = (
  working: WorkingFace,
  glyph: GlyphRef,
  shape: GlyphShape
): WorkingFace => {
  if (glyph.kind === "source") {
    const overrides = new Map(working.overrides);
    overrides.set(glyph.glyphId, {
      advance: shape.advance,
      outline: shape.outline,
    });
    return { ...working, overrides };
  }
  return {
    ...working,
    added: working.added.map((added) =>
      added.key === glyph.key ? { ...added, ...shape } : added
    ),
  };
};
