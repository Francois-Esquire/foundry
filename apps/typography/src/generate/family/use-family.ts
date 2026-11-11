/** The hooks the coordinated side of the Generate screen reads through. */
import { useMemo, useSyncExternalStore } from "react";
import { useApplication } from "~/application/react";
import type { Face } from "~/typeface/face";
import type { Language } from "~/unicode/languages";
import { readTypedCharacters } from "~/unicode/typed-characters";
import { useWorkspace } from "~/workspace/react";
import {
  missingForLanguage,
  missingInScope,
  scopeFromKey,
} from "../missing-characters";
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
  const characters = useMemo(() => {
    if (draft.source === "typed") {
      return readTypedCharacters(draft.typed);
    }
    if (draft.source === "script") {
      const scope = scopeFromKey(draft.scope);
      return scope ? missingInScope(scope, classify) : [];
    }
    const language = languages?.find((known) => known.tag === draft.language);
    return language ? missingForLanguage(language, classify) : [];
  }, [classify, draft, languages]);
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
