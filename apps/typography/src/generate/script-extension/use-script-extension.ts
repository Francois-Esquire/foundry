/** The hooks the script extension's screen reads its session and its face through. */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { browserImageCodec } from "~/generation/browser-image-codec";
import { EMPTY_WORKING_FACE, type WorkingFace } from "~/typeface/changes";
import type { Face } from "~/typeface/face";
import { useWorkspace, useWorkspaceState } from "~/workspace/react";
import type { Workspace, WorkspaceState } from "~/workspace/workspace";
import { type FaceStanding, faceStanding } from "./face-standing";
import { DEVANAGARI_OFFERING } from "./offering";
import {
  createScriptExtensionSession,
  extensionKeysOf,
  type FaceState,
  faceStateOf,
  type ScriptExtensionSession,
} from "./session";

/**
 * One session for each workspace, made the first time it is asked for and
 * kept while the page lives, so a result outlasts a visit to another place.
 */
const sessions = new WeakMap<Workspace, ScriptExtensionSession>();

export const useScriptExtensionSession = (): ScriptExtensionSession => {
  const workspace = useWorkspace();
  let session = sessions.get(workspace);
  if (!session) {
    session = createScriptExtensionSession({
      base: import.meta.env.BASE_URL,
      codec: browserImageCodec,
      fetch: (address) => fetch(address),
      offering: DEVANAGARI_OFFERING,
      workspace,
    });
    sessions.set(workspace, session);
  }
  return session;
};

/** What the session holds for one face. */
export const useFaceState = (
  session: ScriptExtensionSession,
  face: Face
): FaceState => {
  const state = useSyncExternalStore(
    session.subscribe,
    session.getState,
    session.getState
  );
  return faceStateOf(state, face.id);
};

export const useSourceState = (session: ScriptExtensionSession) =>
  useSyncExternalStore(session.subscribe, session.getState, session.getState)
    .source;

/** The face's applied changes as the project has them now. */
export const useWorkingFace = (face: Face): WorkingFace => {
  const workspace = useWorkspace();
  return useWorkspaceState(
    useCallback(
      (state: WorkspaceState) =>
        // A face that has just left the project has no working face to read.
        state.project.faces.some((known) => known.id === face.id)
          ? workspace.workingFace(face.id)
          : EMPTY_WORKING_FACE,
      [face.id, workspace]
    )
  );
};

/** Where the face stands with the plan, read from the project so undo shows at once. */
export const useFaceStanding = (
  session: ScriptExtensionSession,
  face: Face
): FaceStanding => {
  const workspace = useWorkspace();
  const working = useWorkingFace(face);
  const faceState = useFaceState(session, face);
  return useMemo(() => {
    const source = workspace.openFace(face.id);
    return faceStanding({
      extensionKeys: extensionKeysOf(faceState),
      face,
      inSource: (character) =>
        source.glyphForCharacter(character) !== undefined,
      plan: session.offering.plan,
      working,
    });
  }, [face, faceState, session, working, workspace]);
};
