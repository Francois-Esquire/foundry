/** The hooks a screen uses to read what a face covers and the language data. */
import { useMemo } from "react";
import { useSettled } from "~/lib/use-settled";
import type { Face } from "~/typeface/face";
import { type Language, languages } from "~/unicode/languages";
import { useProject, useWorkspace } from "~/workspace/react";
import { type FaceCoverage, readFaceCoverage } from "./face-coverage";

/** What a face covers as the project stands now. Read again when the project changes. */
export const useFaceCoverage = (face: Face): FaceCoverage => {
  const workspace = useWorkspace();
  const project = useProject();
  return useMemo(
    () => readFaceCoverage(project, face.id, workspace.openFace(face.id)),
    [face.id, project, workspace]
  );
};

export type LanguageData =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly languages: readonly Language[] }
  /** The data did not load. A place says so and stops waiting. */
  | { readonly status: "unavailable" };

const LOADING: LanguageData = { status: "loading" };
const UNAVAILABLE: LanguageData = { status: "unavailable" };

/** The language data, which loads on demand: loading, loaded, or not to be had. */
export const useLanguageData = (): LanguageData => {
  const settled = useSettled("languages", languages);
  return useMemo(() => {
    if (!settled) {
      return LOADING;
    }
    return "value" in settled
      ? { languages: settled.value, status: "loaded" }
      : UNAVAILABLE;
  }, [settled]);
};
