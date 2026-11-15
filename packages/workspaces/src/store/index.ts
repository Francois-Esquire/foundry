import type { Page, PageInput } from "@foundry/core/pagination";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceEvent,
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
  /** One Workspace's entries in code-unit path order, then by id. */
  listEntries: (workspaceId: WorkspaceId) => Promise<readonly WorkspaceEntry[]>;
  /**
   * Registrations ordered by creation time, then by id in code-point order
   * (the order of their UTF-8 bytes). The cursor is the offset of the next page;
   * anything but a nonnegative safe integer is refused with a `RangeError`.
   */
  listWorkspaces: (
    input?: PageInput<number>
  ) => Promise<Page<WorkspaceRegistration, number>>;
  /**
   * Runs one read-modify-write so that no other write to the store lands
   * between its reads and its commit, from any catalog over the store. `work`
   * reads and commits through `view` only, and its reads see its own commits.
   * A commit from outside waits for the transaction to end, then lands. If
   * `work` throws, none of its commits stay. Without it, mutations are
   * serialized per catalog and no further.
   */
  transaction?: <T>(work: (view: WorkspaceStore) => Promise<T>) => Promise<T>;
}

/**
 * One atomic write to one Workspace: a save or a removal, and the events
 * that say what it changes.
 */
export type WorkspaceStoreWrite = (WorkspaceRemoval | WorkspaceSave) &
  WorkspaceWriteEvents;

/**
 * What a write changes, as the catalog records it, in order. A store keeps
 * none of them: it takes them with the rest of the write, refuses them as
 * it refuses any value it cannot copy, and passes them on to a host hook
 * (`SqliteWorkspaceStore`'s `onCommit`) unchanged.
 */
export interface WorkspaceWriteEvents {
  readonly events?: readonly WorkspaceEvent[];
}

/**
 * A registration as it now stands, and the entry changes beside it. Entry
 * deletes apply before entry puts. A delete names an entry of the saved
 * Workspace; a put files the entry under its own `workspaceId`.
 */
export interface WorkspaceSave {
  readonly deleteEntries?: readonly WorkspaceEntryId[];
  readonly putEntries?: readonly WorkspaceEntry[];
  readonly removeWorkspace?: never;
  readonly workspace: WorkspaceRegistration;
}

/**
 * Deletes a registration and every entry filed under it, whatever wrote
 * them. It names no entries; a store ignores any it is handed.
 */
export interface WorkspaceRemoval {
  readonly deleteEntries?: never;
  readonly putEntries?: never;
  readonly removeWorkspace: WorkspaceId;
  readonly workspace?: never;
}
