import type { ScriptExtensionPlan } from "~/generation/script-extension/plan";
import type { AddedGlyph } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import { type TypefaceProject, workingFaceOf } from "~/typeface/project";

/**
 * The glyphs of a plan's extension that a face has now. A revision is the
 * plan's extension when it adds layout rules to the face, adds at least one
 * glyph, and every glyph it adds to that face is one the plan names. The
 * rule reads no run id, so it holds for a project whose revision names
 * none. A glyph removed since is not counted. The extension is in the face
 * while this is not empty.
 */
export const extensionGlyphs = (
  project: TypefaceProject,
  faceId: FaceId,
  plan: ScriptExtensionPlan
): readonly AddedGlyph[] => {
  const names = new Set(plan.glyphs.map((glyph) => glyph.name));
  const keys = new Set<string>();
  for (const revision of project.revisions.slice(0, project.head)) {
    const changes = revision.changes.filter(
      (change) => change.faceId === faceId
    );
    const added = changes.flatMap((change) =>
      change.kind === "glyph-added" ? [change.glyph] : []
    );
    const extension =
      changes.some((change) => change.kind === "features-added") &&
      added.length > 0 &&
      added.every((glyph) => names.has(glyph.name));
    for (const change of changes) {
      if (change.kind === "glyph-removed") {
        keys.delete(change.key);
      }
      if (change.kind === "glyph-added") {
        keys.delete(change.glyph.key);
        if (extension) {
          keys.add(change.glyph.key);
        }
      }
    }
  }
  return workingFaceOf(project, faceId).added.filter((glyph) =>
    keys.has(glyph.key)
  );
};
