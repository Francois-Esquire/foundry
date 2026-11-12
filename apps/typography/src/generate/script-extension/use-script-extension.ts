/** The hooks the script extension's screen reads its session and its face through. */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useApplication } from "~/application/react";
import { EMPTY_WORKING_FACE, type WorkingFace } from "~/typeface/changes";
import type { Face } from "~/typeface/face";
import { useProject, useWorkspace, useWorkspaceState } from "~/workspace/react";
import type { WorkspaceState } from "~/workspace/workspace";
import { type FaceStanding, faceStanding } from "./face-standing";
import {
  type FaceState,
  faceStateOf,
  type ScriptExtensionSession,
} from "./session";

/**
 * The application's one session of the script extension on offer, made the
 * first time it is asked for and kept while the application is open, so a
 * result outlasts a visit to another place.
 */
export const useScriptExtensionSession = (): ScriptExtensionSession =>
  useApplication().places.screen.scriptExtension();

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
  const project = useProject();
  return useMemo(() => {
    const source = workspace.openFace(face.id);
    return faceStanding({
      face,
      inSource: (character) =>
        source.glyphForCharacter(character) !== undefined,
      plan: session.offering.plan,
      project,
    });
  }, [face, project, session, workspace]);
};
