/** The hooks the coordinated side of the Generate screen reads through. */
import { useMemo, useSyncExternalStore } from "react";
import { useApplication } from "~/application/react";
import type { Face } from "~/typeface/face";
import type { Language } from "~/unicode/languages";
import { useWorkspace } from "~/workspace/react";
import { namedCharacters } from "../request-draft";
import type { Draft } from "../session";
import { useClassification } from "../use-session";
import { type FamilyPlan, planFamilyRequest } from "./family-plan";
import type { FamilySession, FamilyState } from "./family-session";

/** The application's one session of coordinated runs, kept while the application is open. */
export const useFamilySession = (): FamilySession =>
  useApplication().places.screen.family();

export const useFamilyState = (session: FamilySession): FamilyState =>
  useSyncExternalStore(session.subscribe, session.getState, session.getState);

/** The characters a draft asks for, and their plan for every weight of a variable face. */
export const useFamilyPlan = (
  face: Face,
  draft: Draft,
  languages: readonly Language[] | undefined
): FamilyPlan & { readonly characters: readonly number[] } => {
  const workspace = useWorkspace();
  const { classify } = useClassification(face);
  const characters = useMemo(
    () => namedCharacters(draft, classify, languages),
    [classify, draft, languages]
  );
  return useMemo(
    () => ({
      characters,
      ...planFamilyRequest(
        workspace.openFace(face.id),
        characters,
        (character) => workspace.glyphForCharacter(face.id, character)
      ),
    }),
    [characters, face.id, workspace]
  );
};
