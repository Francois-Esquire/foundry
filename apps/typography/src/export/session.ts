/**
 * What the Export place holds for as long as the project is open: the plan
 * being chosen and the fonts built from it. Screens unmount when the place
 * changes, so the application holds one session for its open project, and
 * the Proof place reads the built fonts from it.
 */

import { createStore } from "~/lib/store";
import type { ExportResolution } from "~/packaging/resolving";
import { headRevisionId, type TypefaceProject } from "~/typeface/project";
import {
  type BuildRunDependencies,
  type BuiltFont,
  builtOf,
  type OutputRun,
  runBuilds,
} from "./build-run";
import type { PlanDraft } from "./plan-draft";

/** What a build was made from, kept so a later change to either can be seen. */
export interface BuildBasis {
  readonly draft: PlanDraft;
  readonly project: TypefaceProject;
}

export interface BuildRun {
  readonly basis: BuildBasis;
  readonly outputs: readonly OutputRun[];
  readonly running: boolean;
}

export interface ExportSessionState {
  /** Undefined until the Export place has been opened with a font in the project. */
  readonly draft: PlanDraft | undefined;
  /** The latest build. A new build replaces it. */
  readonly run: BuildRun | undefined;
}

/** What a session builds and checks with, and stamps each built font with. */
export type ExportMeans = Omit<BuildRunDependencies, "browserCheck">;

export interface ExportSession {
  /**
   * Builds and validates the plan's derived fonts. Does nothing while a
   * build is running. `browserCheck` rejects when the browser will not load
   * a font. Left out, that check is not run.
   */
  build(
    basis: BuildBasis,
    resolution: ExportResolution,
    browserCheck?: BuildRunDependencies["browserCheck"]
  ): Promise<void>;
  getState(): ExportSessionState;
  setDraft(draft: PlanDraft): void;
  /** Returns a function that stops the listener. */
  subscribe(listener: () => void): () => void;
}

export const createExportSession = (means: ExportMeans): ExportSession => {
  const store = createStore<ExportSessionState>({
    draft: undefined,
    run: undefined,
  });
  const setState = store.patch;
  return {
    async build(basis, resolution, browserCheck) {
      if (store.getState().run?.running) {
        return;
      }
      setState({ run: { basis, outputs: [], running: true } });
      const outputs = await runBuilds(
        resolution,
        { ...means, browserCheck },
        headRevisionId(basis.project),
        (progress) =>
          setState({ run: { basis, outputs: progress, running: true } })
      );
      setState({ run: { basis, outputs, running: false } });
    },
    getState: store.getState,
    setDraft: (draft) => setState({ draft }),
    subscribe: store.subscribe,
  };
};

/** True when the plan or the project is no longer what the run was built from. */
export const isOutdated = (run: BuildRun, current: BuildBasis) =>
  run.basis.project !== current.project ||
  JSON.stringify(run.basis.draft) !== JSON.stringify(current.draft);

/** Every font the latest build finished, in plan order. */
export const builtFonts = (state: ExportSessionState): BuiltFont[] =>
  builtOf(state.run?.outputs ?? []);

/**
 * True when the project's applied revisions are no longer the ones a font
 * was built from: something was edited, accepted, undone or redone since.
 */
export const changedSinceBuilt = (
  font: Pick<BuiltFont, "revisionId">,
  project: TypefaceProject
) => font.revisionId !== headRevisionId(project);
