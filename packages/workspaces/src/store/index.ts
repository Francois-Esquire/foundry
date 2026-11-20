import type { Page, PageInput } from "@foundry/core/pagination";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceEvent,
  WorkspaceId,
  WorkspaceRegistration,
} from "../types";

export interface WorkspaceStore {
  commit: (write: WorkspaceStoreWrite) => Promise<void>;
  findWorkspaceByPath: (path: string) => Promise<WorkspaceRegistration | null>;
  findWorkspaceBySourceId: (
    sourceId: string
  ) => Promise<WorkspaceRegistration | null>;
  getEntry: (
    workspaceId: WorkspaceId,
    entryId: WorkspaceEntryId
  ) => Promise<WorkspaceEntry | null>;
  getWorkspace: (
    workspaceId: WorkspaceId
  ) => Promise<WorkspaceRegistration | null>;
  listEntries: (workspaceId: WorkspaceId) => Promise<readonly WorkspaceEntry[]>;
  listWorkspaces: (
    input?: PageInput<number>
  ) => Promise<Page<WorkspaceRegistration, number>>;
  transaction?: <T>(work: (view: WorkspaceStore) => Promise<T>) => Promise<T>;
}

export type WorkspaceStoreWrite = WorkspaceRemoval | WorkspaceSave;

export interface WorkspaceSave {
  readonly deleteEntries?: readonly WorkspaceEntryId[];
  readonly events?: readonly WorkspaceEvent[];
  readonly putEntries?: readonly WorkspaceEntry[];
  readonly removeWorkspace?: never;
  readonly workspace: WorkspaceRegistration;
}

export interface WorkspaceRemoval {
  readonly deleteEntries?: never;
  readonly events?: readonly WorkspaceEvent[];
  readonly putEntries?: never;
  readonly removeWorkspace: WorkspaceId;
  readonly workspace?: never;
}
