/**
 * Plan, for a coordinated run: the same targets for every weight, planned
 * once from the variable face. Only characters the face lacks are planned.
 * A character the face has would be a holdout test, and a holdout test
 * compares with one glyph at one weight, which a run across weights has no
 * place for.
 */
import type { GlyphRef } from "~/typeface/changes";
import type { OpenFace } from "~/typeface/reading";
import { planRequest, type RequestPlan } from "../request-plan";

export interface FamilyPlan {
  /** Requested characters the face already has, left out of the run. */
  readonly alreadyInFace: readonly number[];
  readonly plan: RequestPlan;
}

export const planFamilyRequest = (
  face: OpenFace,
  characters: readonly number[],
  glyphFor: (character: number) => GlyphRef | undefined
): FamilyPlan => {
  const asked = [...new Set(characters)];
  const alreadyInFace = asked.filter(
    (character) => face.glyphForCharacter(character) !== undefined
  );
  const known = new Set(alreadyInFace);
  return {
    alreadyInFace,
    plan: planRequest(
      face,
      asked.filter((character) => !known.has(character)),
      glyphFor
    ),
  };
};
