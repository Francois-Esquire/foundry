/** What the Export and Proof screens read: the project, the export session and the language data. */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useApplication } from "~/application/react";
import type { FaceId } from "~/typeface/face";
import type { TypefaceProject } from "~/typeface/project";
import { type Language, languages } from "~/unicode/languages";
import { useWorkspaceState } from "~/workspace/react";
import type { ExportSession, ExportSessionState } from "./session";

export const useProject = (): TypefaceProject =>
  useWorkspaceState(useCallback((state) => state.project, []));

/** The face the person last worked on, which a new plan or proof starts from. */
export const useActiveFaceId = (): FaceId | undefined =>
  useWorkspaceState(useCallback((state) => state.activeFaceId, []));

export const useExportSession = (): {
  readonly session: ExportSession;
  readonly state: ExportSessionState;
} => {
  const session = useApplication().places.export;
  const state = useSyncExternalStore(
    session.subscribe,
    session.getState,
    session.getState
  );
  return { session, state };
};

export type LanguageData =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly languages: readonly Language[] }
  /** The data did not load. Plans can still be made without languages. */
  | { readonly status: "unavailable" };

/** The language data loads on demand, and a plan must not be resolved before it has. */
export const useLanguageData = (): LanguageData => {
  const [data, setData] = useState<LanguageData>({ status: "loading" });
  useEffect(() => {
    let current = true;
    languages().then(
      (loaded) => {
        if (current) {
          setData({ languages: loaded, status: "loaded" });
        }
      },
      () => {
        if (current) {
          setData({ status: "unavailable" });
        }
      }
    );
    return () => {
      current = false;
    };
  }, []);
  return data;
};
