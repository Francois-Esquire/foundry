import type { FileKind, WorkspaceFileId, WorkspaceId } from "./workspace";

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

/**
 * What one observation of a source says about a File: everything a row carries
 * that is not identity or lifecycle.
 *
 * Written out once, here, and referenced everywhere else. A candidate the
 * scanner produces, the comparison that decides whether a row changed, and the
 * fields an update writes are all derived from this list, so a new observed
 * fact cannot be recorded in one place and forgotten in another.
 */
export const OBSERVED_KEYS = [
  "path",
  "name",
  "extension",
  "mimeType",
  "kind",
  "checksum",
  "size",
] as const;

export type ObservedFacts = Pick<
  StoredFileRecord,
  (typeof OBSERVED_KEYS)[number]
>;

/** Store-owned File state. Identity and observed facts only — never content. */
export interface StoredFileRecord {
  readonly checksum: string;
  readonly createdAt: Date;
  readonly extension: string | null;
  readonly id: WorkspaceFileId;
  readonly kind: FileKind;
  readonly mimeType: string | null;
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly updatedAt: Date;
  readonly workspaceId: WorkspaceId;
}

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
  readonly deletedIds: readonly WorkspaceFileId[];
  readonly inserted: readonly StoredFileRecord[];
  readonly updated: readonly StoredFileRecord[];
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
    readonly files: readonly StoredFileRecord[];
  }) => Promise<CommitCreateResult>;

  /**
   * Records what one successful source write observed about one File — the
   * facts of the bytes just written, applied atomically to the existing row.
   * Not a content store, not a second reconciliation, and never an identity
   * allocator: it refuses rather than inserting.
   */
  commitFileObservation: (input: {
    readonly workspaceId: WorkspaceId;
    readonly fileId: WorkspaceFileId;
    readonly observed: ObservedFacts;
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
  getFile: (
    workspaceId: WorkspaceId,
    fileId: WorkspaceFileId
  ) => Promise<StoredFileRecord | null>;
  getWorkspace: (
    workspaceId: WorkspaceId
  ) => Promise<StoredWorkspaceRecord | null>;
  listFiles: (workspaceId: WorkspaceId) => Promise<readonly StoredFileRecord[]>;
  listWorkspaces: () => Promise<readonly StoredWorkspaceRecord[]>;

  removeWorkspace: (workspaceId: WorkspaceId) => Promise<RemoveWorkspaceResult>;

  renameWorkspace: (
    workspaceId: WorkspaceId,
    name: string,
    updatedAt: Date
  ) => Promise<StoredWorkspaceRecord | null>;
}
