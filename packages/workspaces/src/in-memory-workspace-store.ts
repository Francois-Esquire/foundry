import { byCodeUnit } from "./ordering";
import type { WorkspaceFileId, WorkspaceId } from "./workspace";
import type {
  CommitCreateResult,
  CommitFileObservationResult,
  CommitReconcileResult,
  ObservedFacts,
  RemoveWorkspaceResult,
  StoredFileRecord,
  StoredWorkspaceRecord,
  WorkspaceCatalogChange,
  WorkspaceStore,
} from "./workspace-store";
import { nextWorkspaceObservation } from "./workspace-store";

/** Zero-configuration reference persistence for WorkspaceSystem. */
export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly workspaces = new Map<WorkspaceId, StoredWorkspaceRecord>();
  private readonly files = new Map<WorkspaceFileId, StoredFileRecord>();

  getWorkspace(
    workspaceId: WorkspaceId
  ): Promise<StoredWorkspaceRecord | null> {
    const record = this.workspaces.get(workspaceId);
    return Promise.resolve(record ? copyWorkspace(record) : null);
  }

  findWorkspaceByPath(path: string): Promise<StoredWorkspaceRecord | null> {
    for (const record of this.workspaces.values()) {
      if (record.path === path) {
        return Promise.resolve(copyWorkspace(record));
      }
    }
    return Promise.resolve(null);
  }

  listWorkspaces(): Promise<readonly StoredWorkspaceRecord[]> {
    const ordered = [...this.workspaces.values()]
      .sort(byCreatedAtThenId)
      .map(copyWorkspace);
    return Promise.resolve(ordered);
  }

  listFiles(workspaceId: WorkspaceId): Promise<readonly StoredFileRecord[]> {
    return Promise.resolve(this.ownedFiles(workspaceId).map(copyFile));
  }

  countFiles(workspaceId: WorkspaceId): Promise<number> {
    return Promise.resolve(this.ownedFiles(workspaceId).length);
  }

  getFile(
    workspaceId: WorkspaceId,
    fileId: WorkspaceFileId
  ): Promise<StoredFileRecord | null> {
    const file = this.files.get(fileId);
    return Promise.resolve(
      file?.workspaceId === workspaceId ? copyFile(file) : null
    );
  }

  commitCreate(input: {
    readonly workspace: StoredWorkspaceRecord;
    readonly files: readonly StoredFileRecord[];
  }): Promise<CommitCreateResult> {
    // Both uniqueness rules SQLite enforces with indexes: the root, and a
    // non-null source reference. Checking only the root here would let this
    // store accept a second Workspace over one Artifact that the durable store
    // rejects.
    const claimed = this.claimantFor(input.workspace);
    if (claimed) {
      return Promise.resolve({ existingId: claimed, kind: "workspace-exists" });
    }
    this.workspaces.set(input.workspace.id, copyWorkspace(input.workspace));
    for (const file of input.files) {
      this.files.set(file.id, copyFile(file));
    }
    return Promise.resolve({ kind: "committed" });
  }

  commitFileObservation(input: {
    readonly workspaceId: WorkspaceId;
    readonly fileId: WorkspaceFileId;
    readonly observed: ObservedFacts;
    readonly updatedAt: Date;
  }): Promise<CommitFileObservationResult> {
    const workspace = this.workspaces.get(input.workspaceId);
    if (!workspace) {
      return Promise.resolve({ kind: "workspace-not-found" });
    }
    const file = this.files.get(input.fileId);
    if (file?.workspaceId !== input.workspaceId) {
      return Promise.resolve({ kind: "file-not-found" });
    }
    // A path change is a move, and a move is reconciliation's decision — this
    // commit only records new facts about the row it was told exists.
    if (file.path !== input.observed.path) {
      return Promise.resolve({ kind: "path-mismatch" });
    }
    this.files.set(input.fileId, {
      ...file,
      ...input.observed,
      updatedAt: new Date(input.updatedAt),
    });
    this.workspaces.set(workspace.id, {
      ...workspace,
      updatedAt: new Date(input.updatedAt),
    });
    return Promise.resolve({ kind: "committed" });
  }

  commitReconcile(input: {
    readonly workspaceId: WorkspaceId;
    readonly updatedAt?: Date;
    readonly lastReconciledAt: Date;
    readonly change: WorkspaceCatalogChange;
  }): Promise<CommitReconcileResult> {
    const workspace = this.workspaces.get(input.workspaceId);
    if (!workspace) {
      return Promise.resolve({ kind: "workspace-not-found" });
    }

    const rejection = this.rejectionFor(input.workspaceId, input.change);
    if (rejection) {
      return Promise.resolve({ kind: "conflict", reason: rejection });
    }

    // Deletes first: the unique `(workspaceId, path)` pair only has to hold at
    // the end of the commit, so a File may arrive at a path this same change
    // frees. Each clause below matches what the durable store's SQL does to
    // the same input, including for rows that are no longer there.
    for (const id of input.change.deletedIds) {
      // `delete ... where workspace_id = ? and id in (...)` simply matches
      // nothing for an absent or foreign id. Neither store treats that as a
      // failure: the row the caller wanted gone is gone either way.
      if (this.files.get(id)?.workspaceId === input.workspaceId) {
        this.files.delete(id);
      }
    }
    for (const file of input.change.updated) {
      // `update ... where workspace_id = ? and id = ?` matches nothing once the
      // row is gone, and nothing when it belongs to someone else. Writing it
      // back here would resurrect a File the durable store left deleted, or
      // hand another Workspace's row to this one.
      if (this.files.get(file.id)?.workspaceId === input.workspaceId) {
        this.files.set(file.id, copyFile(file));
      }
    }
    for (const file of input.change.inserted) {
      this.files.set(file.id, copyFile(file));
    }
    const lastReconciledAt = nextWorkspaceObservation(
      workspace.lastReconciledAt,
      input.lastReconciledAt
    );
    this.workspaces.set(workspace.id, {
      ...workspace,
      ...(input.updatedAt === undefined
        ? {}
        : { updatedAt: new Date(input.updatedAt) }),
      lastReconciledAt,
    });
    return Promise.resolve({ kind: "committed" });
  }

  renameWorkspace(
    workspaceId: WorkspaceId,
    name: string,
    updatedAt: Date
  ): Promise<StoredWorkspaceRecord | null> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      return Promise.resolve(null);
    }
    if (workspace.name === name) {
      return Promise.resolve(copyWorkspace(workspace));
    }
    const renamed = { ...workspace, name, updatedAt: new Date(updatedAt) };
    this.workspaces.set(workspaceId, renamed);
    return Promise.resolve(copyWorkspace(renamed));
  }

  removeWorkspace(workspaceId: WorkspaceId): Promise<RemoveWorkspaceResult> {
    if (!this.workspaces.delete(workspaceId)) {
      return Promise.resolve({ kind: "not-found" });
    }
    for (const file of this.ownedFiles(workspaceId)) {
      this.files.delete(file.id);
    }
    return Promise.resolve({ kind: "removed" });
  }

  /**
   * The Workspace already holding this one's root or source reference.
   *
   * Two sequential passes, root first — not one pass testing both predicates
   * per record. A candidate can collide with one incumbent on its root and a
   * different one on its source reference, and `existingId` is what a duplicate
   * add resolves to, so the winner cannot depend on which record is examined
   * first. SQLite resolves the root globally before it looks at `source_id`;
   * this matches that precedence exactly.
   */
  private claimantFor(candidate: StoredWorkspaceRecord): WorkspaceId | null {
    // Ordered rather than in Map insertion order, so the answer is this
    // store's own documented ordering and not an artifact of write sequence.
    const ordered = [...this.workspaces.values()].sort(byCreatedAtThenId);

    const byPath = ordered.find((existing) => existing.path === candidate.path);
    if (byPath) {
      return byPath.id;
    }
    if (candidate.sourceId === null) {
      return null;
    }

    const byReference = ordered.find(
      (existing) => existing.sourceId === candidate.sourceId
    );
    return byReference?.id ?? null;
  }

  private ownedFiles(workspaceId: WorkspaceId): StoredFileRecord[] {
    return [...this.files.values()]
      .filter((file) => file.workspaceId === workspaceId)
      .sort(byCodeUnit((file) => file.path));
  }

  /**
   * The same rules SQLite enforces inside the transaction — ownership and the
   * unique `(workspaceId, path)` pair — checked before anything is written, so
   * a rejected commit leaves the prior catalog exact in both stores.
   */
  private rejectionFor(
    workspaceId: WorkspaceId,
    change: WorkspaceCatalogChange
  ): string | null {
    // Only the ids this commit will actually remove free their paths. An
    // absent or foreign id deletes nothing in either store, so it cannot make
    // room for an arrival either.
    const deleted = new Set(
      change.deletedIds.filter(
        (id) => this.files.get(id)?.workspaceId === workspaceId
      )
    );

    const paths = new Map<string, WorkspaceFileId>();
    for (const file of this.ownedFiles(workspaceId)) {
      if (!deleted.has(file.id)) {
        paths.set(file.path, file.id);
      }
    }
    for (const file of change.updated) {
      if (file.workspaceId !== workspaceId) {
        return `File ${file.id} is not owned by Workspace ${workspaceId}`;
      }
      // The same guard the apply loop uses. An update that matches no row
      // writes nothing, so it cannot hold a path against an arrival either —
      // and claiming one here would reject a commit SQLite accepts.
      if (this.files.get(file.id)?.workspaceId !== workspaceId) {
        continue;
      }
      const rejection = claim(paths, workspaceId, file);
      if (rejection) {
        return rejection;
      }
    }
    for (const file of change.inserted) {
      if (file.workspaceId !== workspaceId) {
        return `File ${file.id} is not owned by Workspace ${workspaceId}`;
      }
      const rejection = claim(paths, workspaceId, file);
      if (rejection) {
        return rejection;
      }
    }
    return null;
  }
}

/** Takes a path for one File, or names the row already holding it. */
function claim(
  paths: Map<string, WorkspaceFileId>,
  workspaceId: WorkspaceId,
  file: StoredFileRecord
): string | null {
  const owner = paths.get(file.path);
  if (owner !== undefined && owner !== file.id) {
    return `Duplicate path ${file.path} in Workspace ${workspaceId}`;
  }
  paths.set(file.path, file.id);
  return null;
}

const byId = byCodeUnit((record: StoredWorkspaceRecord) => record.id);

function byCreatedAtThenId(
  a: StoredWorkspaceRecord,
  b: StoredWorkspaceRecord
): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime === 0 ? byId(a, b) : byTime;
}

function copyWorkspace(record: StoredWorkspaceRecord): StoredWorkspaceRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    lastReconciledAt: new Date(record.lastReconciledAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function copyFile(record: StoredFileRecord): StoredFileRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}
