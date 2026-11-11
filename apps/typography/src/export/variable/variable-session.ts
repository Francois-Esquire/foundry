/**
 * What the variable font part of the Export place holds while the project
 * is open: how each variable face is to be exported, which pinned instances
 * are left out of the masters, and the latest variable font built. The
 * application holds one session for its open project, since the screen
 * unmounts when the place changes.
 */

import { createStore } from "~/lib/store";
import type { VariableBuildRequest } from "~/packaging/building";
import type { FaceId } from "~/typeface/face";
import type { TypefaceProject } from "~/typeface/project";
import {
  runVariableBuild,
  type VariableOutcome,
  type VariableRunDependencies,
  type VariableStep,
} from "./variable-run";

/** Each instance as its own static font, or the instances as one variable font. */
export type ExportWay = "static" | "variable";

/** What a build was made from, kept so a later change can be seen. */
export interface VariableBasis {
  readonly fileName: string;
  /** The variable face the masters were pinned from. */
  readonly groupKey: string;
  readonly masterIds: readonly FaceId[];
  readonly project: TypefaceProject;
}

export type VariableRun = { readonly basis: VariableBasis } & (
  | { readonly status: "running"; readonly step: VariableStep }
  | VariableOutcome
);

export interface VariableSessionState {
  /** Pinned instances left out of the masters. */
  readonly excluded: readonly FaceId[];
  /** The latest build. A new build replaces it. */
  readonly run?: VariableRun;
  /** The way chosen for each variable face, by its id. Static when absent. */
  readonly ways: Readonly<Record<string, ExportWay>>;
}

/** What a session builds and checks with, and stamps the built font with. */
export type VariableMeans = Omit<VariableRunDependencies, "browserCheck">;

export interface VariableSession {
  /**
   * Builds and checks one variable font. Does nothing while a build is
   * running. `browserCheck` rejects when the browser will not load the font.
   * Left out, that check is not run.
   */
  build(
    basis: VariableBasis,
    request: VariableBuildRequest,
    browserCheck?: VariableRunDependencies["browserCheck"]
  ): Promise<void>;
  getState(): VariableSessionState;
  /** Puts a pinned instance among the masters, or leaves it out. */
  setMaster(faceId: FaceId, included: boolean): void;
  setWay(groupKey: string, way: ExportWay): void;
  /** Returns a function that stops the listener. */
  subscribe(listener: () => void): () => void;
}

export const createVariableSession = (
  means: VariableMeans
): VariableSession => {
  const store = createStore<VariableSessionState>({ excluded: [], ways: {} });
  const setState = store.patch;
  return {
    async build(basis, request, browserCheck) {
      if (store.getState().run?.status === "running") {
        return;
      }
      const outcome = await runVariableBuild(
        request,
        basis.fileName,
        { ...means, browserCheck },
        (step) => setState({ run: { basis, status: "running", step } })
      );
      setState({ run: { basis, ...outcome } });
    },
    getState: store.getState,
    setMaster(faceId, included) {
      const others = store
        .getState()
        .excluded.filter((excluded) => excluded !== faceId);
      setState({ excluded: included ? others : [...others, faceId] });
    },
    setWay: (groupKey, way) =>
      setState({ ways: { ...store.getState().ways, [groupKey]: way } }),
    subscribe: store.subscribe,
  };
};

/** True when the project, the masters or the file is no longer what the run was built from. */
export const isOutdated = (
  { basis }: VariableRun,
  current: VariableBasis
): boolean =>
  basis.project !== current.project ||
  basis.fileName !== current.fileName ||
  basis.masterIds.join() !== current.masterIds.join();
