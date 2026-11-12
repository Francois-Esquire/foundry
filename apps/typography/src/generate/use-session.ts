/** The hooks the Generate screen reads its session and its face through. */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useApplication } from "~/application/react";
import type { Face } from "~/typeface/face";
import { candidatesWithStatus } from "~/typeface/project";
import { classifyFace, type FaceClassification } from "~/unicode/coverage";
import { useProject, useWorkspace } from "~/workspace/react";
import type { GenerateSession, GenerateState, StyleReading } from "./session";

/**
 * The application's one session for this place, made the first time the
 * place is opened and kept while the application is open, so runs outlast a
 * visit to another place.
 */
export const useGenerateSession = (): GenerateSession =>
  useApplication().places.screen.generate();

export const useGenerateState = (session: GenerateSession): GenerateState =>
  useSyncExternalStore(session.subscribe, session.getState, session.getState);

/** Which characters the face has, as the project stands now. */
export const useClassification = (face: Face): FaceClassification => {
  const workspace = useWorkspace();
  const project = useProject();
  return useMemo(() => {
    const source = workspace.openFace(face.id);
    return classifyFace({
      candidates: candidatesWithStatus(project, "proposed").filter(
        (candidate) => candidate.faceId === face.id
      ),
      glyphForCharacter: (character) => source.glyphForCharacter(character),
      source: source.characters(),
      working: workspace.workingFace(face.id),
    });
  }, [face.id, project, workspace]);
};

/**
 * The style reference of a face. Measuring takes a moment, so it happens
 * after the screen has drawn and the answer arrives a frame later.
 */
export const useStyleReading = (
  session: GenerateSession,
  face: Face
): StyleReading | undefined => {
  const [reading, setReading] = useState<{
    readonly faceId: string;
    readonly value: StyleReading;
  }>();
  useEffect(() => {
    const timer = setTimeout(() => {
      setReading({ faceId: face.id, value: session.styleOf(face.id) });
    }, 0);
    return () => clearTimeout(timer);
  }, [face.id, session]);
  return reading?.faceId === face.id ? reading.value : undefined;
};
