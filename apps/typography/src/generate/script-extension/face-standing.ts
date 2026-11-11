/**
 * Where a face stands with a script extension plan: whether the extension
 * is offered for it, and which of the plan's characters it has now. Read
 * from the project every time, so undo and redo show at once.
 */
import type { ScriptExtensionPlan } from "~/generation/script-extension/plan";
import { count } from "~/lib/count";
import type { WorkingFace } from "~/typeface/changes";
import type { Face } from "~/typeface/face";
import { plannedCharacters } from "./scope";

export type FaceStanding =
  /** The extension's glyphs are in the face, all of them. */
  | { readonly kind: "in-face"; readonly held: number }
  /** The face lacks the plan's characters and can take the extension. */
  | { readonly kind: "lacking"; readonly held: number }
  | {
      readonly kind: "not-offered";
      readonly held: number;
      readonly reason: string;
    };

export interface StandingRequest {
  /** The keys of the extension's glyphs, once it has been run. */
  readonly extensionKeys?: readonly string[];
  readonly face: Face;
  /** True when the face's source font maps the character. */
  readonly inSource: (character: number) => boolean;
  readonly plan: ScriptExtensionPlan;
  readonly working: WorkingFace;
}

/** True when every glyph of an extension is among the face's added glyphs. */
export const extensionInFace = (
  keys: readonly string[],
  working: WorkingFace
): boolean => {
  const added = new Set(working.added.map((glyph) => glyph.key));
  return keys.length > 0 && keys.every((key) => added.has(key));
};

export const faceStanding = ({
  extensionKeys = [],
  face,
  inSource,
  plan,
  working,
}: StandingRequest): FaceStanding => {
  const characters = plannedCharacters(plan);
  const fromSource = characters.filter(inSource);
  const added = characters.filter((character) =>
    working.characters.has(character)
  );
  const held = new Set([...fromSource, ...added]).size;
  const name = face.description.fullName;
  if (extensionInFace(extensionKeys, working)) {
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
  const ours = new Set(extensionKeys);
  const elsewhere = added.filter(
    (character) => !ours.has(working.characters.get(character) ?? "")
  );
  if (elsewhere.length > 0) {
    return {
      held,
      kind: "not-offered",
      reason: `${count(elsewhere.length, "character")} of the plan already ${elsewhere.length === 1 ? "has a glyph" : "have glyphs"} added to ${name} in this project, with Latin spacing and no layout rules. The extension would map them a second time. Undo the revisions that added them, then come back.`,
    };
  }
  return { held, kind: "lacking" };
};
