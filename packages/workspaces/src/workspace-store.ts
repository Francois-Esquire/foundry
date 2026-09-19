import type { FileRepresentation, StorageEntry } from "@foundry/core/storage";

import type { FileClassification } from "./classification";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceId,
} from "./workspace";

/**
 * Store-owned Workspace state. The `source`/`sourceId`/`path` triple is the
 * persistence encoding of the domain's `WorkspaceSource`; the system converts
 * between the two and never leaks this shape outward.
 */
export interface StoredWorkspaceRecord {
  readonly createdAt: Date;
  readonly description: string | null;
  readonly documentation: string | null;
  readonly id: WorkspaceId;
  readonly lastReconciledAt: Date;
  readonly name: string;
  readonly path: string;
  /** The string the layer that owns this source claims. */
  readonly source: string;
  readonly sourceId: string | null;
  readonly updatedAt: Date;
}

export type ObservedFacts =
  | (FileRepresentation & FileClassification)
  | (Exclude<StorageEntry, { readonly type: "file" }> & {
      readonly name: string;
    });

/**
 * `workspace-exists` names the Workspace already registered for this source —
 * matched on the canonical root, or on a non-null source reference. One source
 * cannot have two competing catalogs, so both spellings of "already taken"
 * resolve to the incumbent rather than failing.
 */
export type CommitCreateResult =
  | { readonly kind: "committed" }
  | { readonly kind: "workspace-exists"; readonly existingId: WorkspaceId };

/** One reconciliation's exact diff, applied or not applied as a whole. */
export interface WorkspaceCatalogChange {
  readonly deletedIds: readonly WorkspaceEntryId[];
  readonly inserted: readonly WorkspaceEntry[];
  readonly updated: readonly WorkspaceEntry[];
}

export type CommitReconcileResult =
  | { readonly kind: "committed" }
  | { readonly kind: "workspace-not-found" }
  | { readonly kind: "conflict"; readonly reason: string };

/**
 * Refusals are explicit: a missing Workspace or File, or a row whose stored
 * path no longer matches the observation's, must never become an insert or a
 * replacement row.
 */
export type CommitFileObservationResult =
  | { readonly kind: "committed" }
  | { readonly kind: "workspace-not-found" }
  | { readonly kind: "file-not-found" }
  | { readonly kind: "path-mismatch" };

export type RemoveWorkspaceResult =
  | { readonly kind: "removed" }
  | { readonly kind: "not-found" };

/** Gives successful source observations a strict, shared order. */
export function nextWorkspaceObservation(
  previous: Date,
  requested: Date = new Date()
): Date {
  return new Date(Math.max(previous.getTime() + 1, requested.getTime()));
}

/**
 * Persistence capability consumed by WorkspaceSystem.
 *
 * Implementations store canonical records and own atomicity. They do not
 * canonicalize paths, scan sources, classify content, match moves, or choose
 * domain errors — that is WorkspaceSystem behavior.
 */
export interface WorkspaceStore {
  /** Inserts one Workspace and its complete initial catalog together. */
  commitCreate: (input: {
    readonly workspace: StoredWorkspaceRecord;
    readonly entries: readonly WorkspaceEntry[];
  }) => Promise<CommitCreateResult>;

  /**
   * Records what one successful source write observed about one File — the
   * facts of the bytes just written, applied atomically to the existing row.
   * Not a content store, not a second reconciliation, and never an identity
   * allocator: it refuses rather than inserting.
   */
  commitFileObservation: (input: {
    readonly workspaceId: WorkspaceId;
    readonly fileId: WorkspaceEntryId;
    readonly observed: Extract<ObservedFacts, { readonly type: "file" }>;
    readonly updatedAt: Date;
  }) => Promise<CommitFileObservationResult>;

  /** Applies one reconciliation diff, or none of it. */
  commitReconcile: (input: {
    readonly workspaceId: WorkspaceId;
    /** Set only when the observation changed the File catalog. */
    readonly updatedAt?: Date;
    readonly lastReconciledAt: Date;
    readonly change: WorkspaceCatalogChange;
  }) => Promise<CommitReconcileResult>;
  countFiles: (workspaceId: WorkspaceId) => Promise<number>;
  /** Looks a Workspace up by its canonical root, which is unique per source. */
  findWorkspaceByPath: (path: string) => Promise<StoredWorkspaceRecord | null>;
  getEntry: (
    workspaceId: WorkspaceId,
    entryId: WorkspaceEntryId
  ) => Promise<WorkspaceEntry | null>;
  getWorkspace: (
    workspaceId: WorkspaceId
  ) => Promise<StoredWorkspaceRecord | null>;
  listEntries: (workspaceId: WorkspaceId) => Promise<readonly WorkspaceEntry[]>;
  listWorkspaces: () => Promise<readonly StoredWorkspaceRecord[]>;

  removeWorkspace: (workspaceId: WorkspaceId) => Promise<RemoveWorkspaceResult>;

  renameWorkspace: (
    workspaceId: WorkspaceId,
    name: string,
    updatedAt: Date
  ) => Promise<StoredWorkspaceRecord | null>;
}
