import {
  createContext,
  type ReactNode,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";
import type { Face } from "~/typeface/face";
import { candidateStatuses, type TypefaceProject } from "~/typeface/project";
import type { Workspace, WorkspaceState } from "./workspace";

const WorkspaceContext = createContext<Workspace | undefined>(undefined);

export const WorkspaceProvider = ({
  children,
  workspace,
}: {
  readonly children: ReactNode;
  readonly workspace: Workspace;
}) => <WorkspaceContext value={workspace}>{children}</WorkspaceContext>;

export const useWorkspace = (): Workspace => {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) {
    throw new Error("useWorkspace needs a WorkspaceProvider above it.");
  }
  return workspace;
};

interface Selection<T> {
  readonly selector: (state: WorkspaceState) => T;
  readonly state: WorkspaceState;
  readonly value: T;
}

/**
 * Reads part of the workspace state and renders again when the workspace
 * changes. The selector may build a new array or object: its result is kept
 * for as long as the state and the selector stay the same, so the snapshot is
 * stable. A selector that builds a new value renders on every state change;
 * select the smallest piece you need.
 */
export const useWorkspaceState = <T,>(
  selector: (state: WorkspaceState) => T
): T => {
  const workspace = useWorkspace();
  const selection = useRef<Selection<T> | undefined>(undefined);
  const getSnapshot = () => {
    const state = workspace.getState();
    const last = selection.current;
    if (last?.state === state && last.selector === selector) {
      return last.value;
    }
    const value = selector(state);
    selection.current = { selector, state, value };
    return value;
  };
  return useSyncExternalStore(workspace.subscribe, getSnapshot, getSnapshot);
};

const selectProject = (state: WorkspaceState) => state.project;

const selectActiveFace = (state: WorkspaceState) =>
  state.project.faces.find((face) => face.id === state.activeFaceId);

export const useProject = (): TypefaceProject =>
  useWorkspaceState(selectProject);

/**
 * The face every place is looking at, and the one way a place picks its
 * face. Undefined only while the project has no font.
 */
export const useActiveFace = (): Face | undefined =>
  useWorkspaceState(selectActiveFace);

/** Reads candidate standing from the current project and subscribes to history changes. */
export const useCandidateStatuses = () =>
  useWorkspaceState((state) => candidateStatuses(state.project));
