/**
 * Where a face stands with a script extension plan: whether the extension
 * is offered for it, and which of the plan's characters it has now. Read
 * from the project every time, so undo and redo show at once.
 */
import type { ScriptExtensionPlan } from "~/generation/script-extension/plan";
import { count } from "~/lib/count";
import type { Face } from "~/typeface/face";
import { type TypefaceProject, workingFaceOf } from "~/typeface/project";
import { extensionGlyphs } from "./extension-glyphs";
import { plannedCharacters } from "./scope";

export type FaceStanding =
  /** At least one glyph of the extension remains in the face. */
  | { readonly kind: "in-face"; readonly held: number }
  /** The face lacks the plan's characters and can take the extension. */
  | { readonly kind: "lacking"; readonly held: number }
  | {
      readonly kind: "not-offered";
      readonly held: number;
      readonly reason: string;
    };

export interface StandingRequest {
  readonly face: Face;
  /** True when the face's source font maps the character. */
  readonly inSource: (character: number) => boolean;
  readonly plan: ScriptExtensionPlan;
  readonly project: TypefaceProject;
}

export const EXTENSION_IN_FACE =
  "The extension is in the face. Undo it to run again.";

export const faceStanding = ({
  project,
  face,
  inSource,
  plan,
}: StandingRequest): FaceStanding => {
  const characters = plannedCharacters(plan);
  const working = workingFaceOf(project, face.id);
  const fromSource = characters.filter(inSource);
  const added = characters.filter((character) =>
    working.characters.has(character)
  );
  const held = new Set([...fromSource, ...added]).size;
  const name = face.description.fullName;
  if (extensionGlyphs(project, face.id, plan).length > 0) {
    return { held, kind: "in-face" };
  }
  if (face.pinned) {
    return {
      held,
      kind: "not-offered",
      reason: `${name} is a pinned instance of a variable font. The extension is verified against the source font file as it was imported, which for a pinned instance is the whole variable font, so it is offered for static faces only.`,
    };
  }
  if (fromSource.length > 0) {
    return {
      held,
      kind: "not-offered",
      reason: `${name} already has ${fromSource.length} of the plan's ${count(characters.length, "character")} in its source font. The extension adds glyphs for characters a face lacks, so it is not offered for this face.`,
    };
  }
  if (added.length > 0) {
    return {
      held,
      kind: "not-offered",
      reason: `${count(added.length, "character")} of the plan already ${added.length === 1 ? "has a glyph" : "have glyphs"} added to ${name} in this project, with Latin spacing and no layout rules. The extension would map them a second time. Undo the revisions that added them, then come back.`,
    };
  }
  return { held, kind: "lacking" };
};
