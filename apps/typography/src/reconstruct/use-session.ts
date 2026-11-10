/** The hooks the Reconstruct screen reads its session and the project through. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { browserImageCodec } from "~/generation/browser-image-codec";
import type { TypefaceProject } from "~/typeface/project";
import { useWorkspace, useWorkspaceState } from "~/workspace/react";
import { useFontBuilder } from "~/workspace/services";
import type { Workspace, WorkspaceState } from "~/workspace/workspace";
import type { Evidence } from "./core";
import {
  createReconstructSession,
  type ReconstructSession,
  type ReconstructState,
} from "./session";

/**
 * One session for each workspace, made the first time the place is opened
 * and kept while the page lives, so the evidence and what was read from it
 * outlast a visit to the Studio.
 */
const sessions = new WeakMap<Workspace, ReconstructSession>();

export const useReconstructSession = (): ReconstructSession => {
  const workspace = useWorkspace();
  const builder = useFontBuilder();
  let session = sessions.get(workspace);
  if (!session) {
    session = createReconstructSession({
      base: import.meta.env.BASE_URL,
      builder,
      codec: browserImageCodec,
      fetch: (address) => fetch(address),
      workspace,
    });
    sessions.set(workspace, session);
  }
  return session;
};

export const useReconstructState = (
  session: ReconstructSession
): ReconstructState =>
  useSyncExternalStore(session.subscribe, session.getState, session.getState);

const selectProject = (state: WorkspaceState) => state.project;

export const useProject = (): TypefaceProject =>
  useWorkspaceState(selectProject);

/** The evidence with an address the browser can draw it from. */
export interface Photograph {
  readonly evidence: Evidence;
  /** Points at the evidence file's own bytes. Nothing is re-encoded. */
  readonly url: string;
}

/** An address for the evidence file, kept for as long as the evidence is on screen. */
export const usePhotograph = (
  evidence: Evidence | undefined
): Photograph | undefined => {
  const [photograph, setPhotograph] = useState<Photograph>();
  useEffect(() => {
    if (!evidence) {
      setPhotograph(undefined);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([evidence.file.bytes as Uint8Array<ArrayBuffer>], {
        type: evidence.file.mediaType,
      })
    );
    setPhotograph({ evidence, url });
    return () => URL.revokeObjectURL(url);
  }, [evidence]);
  return photograph?.evidence === evidence ? photograph : undefined;
};
