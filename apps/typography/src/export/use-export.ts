/** How the Export and Proof screens read the export session. */
import { useSyncExternalStore } from "react";
import { useApplication } from "~/application/react";
import type { ExportSession, ExportSessionState } from "./session";

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
