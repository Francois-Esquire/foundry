/** The hooks the coordinated side of the Generate screen reads through. */
import { useMemo, useSyncExternalStore } from "react";
import { browserImageCodec } from "~/generation/browser-image-codec";
import type { Face } from "~/typeface/face";
import type { Language } from "~/unicode/languages";
import { useWorkspace } from "~/workspace/react";
import type { Workspace } from "~/workspace/workspace";
import {
  missingForLanguage,
  missingInScope,
  scopeFromKey,
} from "../missing-characters";
import type { Draft } from "../session";
import { readTypedCharacters } from "../typed-characters";
import { useClassification } from "../use-session";
import { type FamilyPlan, planFamilyRequest } from "./family-plan";
import {
  createFamilySession,
  type FamilySession,
  type FamilyState,
} from "./family-session";

/** One session for each workspace, kept while the page lives. */
const sessions = new WeakMap<Workspace, FamilySession>();

export const useFamilySession = (): FamilySession => {
  const workspace = useWorkspace();
  let session = sessions.get(workspace);
  if (!session) {
    session = createFamilySession({ codec: browserImageCodec, workspace });
    sessions.set(workspace, session);
  }
  return session;
};

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
