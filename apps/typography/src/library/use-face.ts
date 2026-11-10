/** The hooks a screen uses to read the chosen face and what it covers. */
import { useEffect, useMemo, useState } from "react";
import type { Face } from "~/typeface/face";
import type { TypefaceProject } from "~/typeface/project";
import { type Language, languages } from "~/unicode/languages";
import { useWorkspace, useWorkspaceState } from "~/workspace/react";
import type { WorkspaceState } from "~/workspace/workspace";
import { type FaceCoverage, readFaceCoverage } from "./face-coverage";

const selectProject = (state: WorkspaceState) => state.project;

const selectActiveFace = (state: WorkspaceState) =>
  state.project.faces.find((face) => face.id === state.activeFaceId);

export const useProject = (): TypefaceProject =>
  useWorkspaceState(selectProject);

/** The face every place is looking at. Undefined while the project has no font. */
export const useActiveFace = (): Face | undefined =>
  useWorkspaceState(selectActiveFace);

/** What a face covers as the project stands now. Read again when the project changes. */
export const useFaceCoverage = (face: Face): FaceCoverage => {
  const workspace = useWorkspace();
  const project = useProject();
  return useMemo(
    () => readFaceCoverage(project, face.id, workspace.openFace(face.id)),
    [face.id, project, workspace]
  );
};

/** The language data, once it has loaded. */
export const useLanguages = (): readonly Language[] | undefined => {
  const [loaded, setLoaded] = useState<readonly Language[]>();
  useEffect(() => {
    let current = true;
    languages().then((all) => {
      if (current) {
        setLoaded(all);
      }
    });
    return () => {
      current = false;
    };
  }, []);
  return loaded;
};
