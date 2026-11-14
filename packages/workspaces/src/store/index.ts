import type { Page, PageInput } from "@foundry/core/pagination";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceId,
  WorkspaceRegistration,
} from "../types";

/**
 * The persistence seam under the Workspace catalog.
 *
 * A store keeps registrations and their entries and applies one write
 * atomically. It enforces nothing: unique roots and source references,
 * ownership, a valid tree, and all-or-nothing changes are the catalog's
 * rules, checked before a write ever reaches the store. Values crossing this
 * seam are detached — a store never hands out or retains a caller's objects.
 */
export interface WorkspaceStore {
  /** Applies one save or removal, all or nothing. */
  commit: (write: WorkspaceStoreWrite) => Promise<void>;
  /** The oldest registration over this canonical root. */
  findWorkspaceByPath: (path: string) => Promise<WorkspaceRegistration | null>;
  /** The oldest registration over this source reference. */
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
  /** One Workspace's entries in code-unit path order. */
  listEntries: (workspaceId: WorkspaceId) => Promise<readonly WorkspaceEntry[]>;
  /** Registrations ordered by creation time, then id. */
  listWorkspaces: (
    input?: PageInput<number>
  ) => Promise<Page<WorkspaceRegistration, number>>;
}

/**
 * One atomic write to one Workspace: a save or a removal. Entry deletes apply
 * before entry puts.
 */
export type WorkspaceStoreWrite = WorkspaceRemoval | WorkspaceSave;

/** A registration as it now stands, and the entry changes beside it. */
export interface WorkspaceSave {
  readonly deleteEntries?: readonly WorkspaceEntryId[];
  readonly putEntries?: readonly WorkspaceEntry[];
  readonly removeWorkspace?: never;
  readonly workspace: WorkspaceRegistration;
}

/**
 * Deletes a registration and the entries it names. The store deletes only
 * what the write names; the catalog names every entry the Workspace owns.
 */
export interface WorkspaceRemoval {
  readonly deleteEntries: readonly WorkspaceEntryId[];
  readonly putEntries?: never;
  readonly removeWorkspace: WorkspaceId;
  readonly workspace?: never;
}
