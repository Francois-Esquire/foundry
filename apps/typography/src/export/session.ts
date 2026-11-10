/**
 * What the Export place holds for as long as the project is open: the plan
 * being chosen and the fonts built from it. Screens unmount when the place
 * changes, so this lives beside the workspace, one session per workspace,
 * and the Proof place reads the built fonts from it.
 */
import type { ExportResolution } from "~/packaging/resolving";
import { headRevisionId, type TypefaceProject } from "~/typeface/project";
import type { Workspace } from "~/workspace/workspace";
import {
  type BuildRunDependencies,
  type BuiltFont,
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

export interface ExportSession {
  /** Builds and validates the plan's derived fonts. Does nothing while a build is running. */
  build(
    basis: BuildBasis,
    resolution: ExportResolution,
    dependencies: BuildRunDependencies
  ): Promise<void>;
  getState(): ExportSessionState;
  setDraft(draft: PlanDraft): void;
  /** Returns a function that stops the listener. */
  subscribe(listener: () => void): () => void;
}

export const createExportSession = (): ExportSession => {
  let state: ExportSessionState = { draft: undefined, run: undefined };
  const listeners = new Set<() => void>();
  const setState = (next: Partial<ExportSessionState>) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) {
      listener();
    }
  };
  return {
    async build(basis, resolution, dependencies) {
      if (state.run?.running) {
        return;
      }
      setState({ run: { basis, outputs: [], running: true } });
      const outputs = await runBuilds(
        resolution,
        dependencies,
        headRevisionId(basis.project),
        (progress) =>
          setState({ run: { basis, outputs: progress, running: true } })
      );
      setState({ run: { basis, outputs, running: false } });
    },
    getState: () => state,
    setDraft: (draft) => setState({ draft }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const sessions = new WeakMap<Workspace, ExportSession>();

/** The export session of a workspace, created the first time it is asked for. */
export const exportSessionOf = (workspace: Workspace): ExportSession => {
  let session = sessions.get(workspace);
  if (!session) {
    session = createExportSession();
    sessions.set(workspace, session);
  }
  return session;
};

/** True when the plan or the project is no longer what the run was built from. */
export const isOutdated = (run: BuildRun, current: BuildBasis) =>
  run.basis.project !== current.project ||
  JSON.stringify(run.basis.draft) !== JSON.stringify(current.draft);

/** Every font the latest build finished, in plan order. */
export const builtFonts = (state: ExportSessionState): BuiltFont[] =>
  (state.run?.outputs ?? []).flatMap((output) =>
    output.progress.status === "built" ? [output.progress.font] : []
  );

/**
 * True when the project's applied revisions are no longer the ones a font
 * was built from: something was edited, accepted, undone or redone since.
 */
export const changedSinceBuilt = (
  font: Pick<BuiltFont, "revisionId">,
  project: TypefaceProject
) => font.revisionId !== headRevisionId(project);
