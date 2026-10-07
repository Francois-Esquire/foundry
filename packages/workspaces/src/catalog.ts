import type { Page, PageInput } from "@foundry/core/pagination";
import { storageTree } from "@foundry/core/storage";
import { nextWorkspaceObservation } from "./observation";
import type { WorkspaceStore } from "./store";
import type {
  WorkspaceCatalogChange,
  WorkspaceChange,
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceId,
  WorkspaceRegistration,
} from "./types";

/**
 * `workspace-exists` names the Workspace already registered for this source —
 * matched on the canonical root first, then on a non-null source reference.
 * One source cannot have two competing catalogs, so both spellings of
 * "already taken" resolve to the incumbent rather than failing.
 */
export type CommitCreateResult =
  | { readonly kind: "committed" }
  | { readonly kind: "workspace-exists"; readonly existingId: WorkspaceId };

export type CommitChangeResult =
  | { readonly kind: "committed" }
  | { readonly kind: "workspace-not-found" }
  | { readonly kind: "conflict"; readonly reason: string };

export type RemoveWorkspaceResult =
  | { readonly kind: "removed" }
  | { readonly kind: "not-found" };

export interface CatalogChangeInput {
  readonly change: WorkspaceCatalogChange;
  /** Set only by a complete source observation. */
  readonly lastReconciledAt?: Date;
  /** Set only when the change touches the catalog. */
  readonly updatedAt?: Date;
  readonly workspaceId: WorkspaceId;
}

/**
 * Every rule over the Workspaces a store holds, and the one place catalog
 * changes are published.
 *
 * One Workspace per canonical root and per source reference; entries belong
 * to their Workspace; every change leaves a valid tree and lands whole or not
 * at all. Mutations run one at a time, so a rule checked against what the
 * store holds still holds when the write lands. In-process only: a second
 * catalog over the same store can still interleave.
 */
export class WorkspaceCatalog {
  private readonly store: WorkspaceStore;
  private readonly publish: (changes: readonly WorkspaceChange[]) => void;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    store: WorkspaceStore,
    publish: (changes: readonly WorkspaceChange[]) => void
  ) {
    this.store = store;
    this.publish = publish;
  }

  getWorkspace(
    workspaceId: WorkspaceId
  ): Promise<WorkspaceRegistration | null> {
    return this.store.getWorkspace(workspaceId);
  }

  findWorkspaceByPath(path: string): Promise<WorkspaceRegistration | null> {
    return this.store.findWorkspaceByPath(path);
  }

  listWorkspaces(
    input?: PageInput<number>
  ): Promise<Page<WorkspaceRegistration, number>> {
    return this.store.listWorkspaces(input);
  }

  getEntry(
    workspaceId: WorkspaceId,
    entryId: WorkspaceEntryId
  ): Promise<WorkspaceEntry | null> {
    return this.store.getEntry(workspaceId, entryId);
  }

  listEntries(workspaceId: WorkspaceId): Promise<readonly WorkspaceEntry[]> {
    return this.store.listEntries(workspaceId);
  }

  async countFiles(workspaceId: WorkspaceId): Promise<number> {
    const entries = await this.store.listEntries(workspaceId);
    return entries.filter((entry) => entry.type === "file").length;
  }

  /** Registers one Workspace with its complete initial catalog. */
  create(input: {
    readonly workspace: WorkspaceRegistration;
    readonly entries: readonly WorkspaceEntry[];
  }): Promise<CommitCreateResult> {
    return this.exclusive(async () => {
      const { workspace, entries } = input;
      const incumbent = await this.claimant(workspace);
      if (incumbent) {
        return { existingId: incumbent.id, kind: "workspace-exists" };
      }
      const foreign = entries.find(
        (entry) => entry.workspaceId !== workspace.id
      );
      if (foreign) {
        throw new Error(
          `Entry ${foreign.id} does not belong to ${workspace.id}`
        );
      }
      storageTree(entries);
      await this.store.commit({ putEntries: entries, workspace });
      this.publish(entries.map((entry) => ({ action: "add", entry })));
      return { kind: "committed" };
    });
  }

  /**
   * Applies one change against the catalog as it stands, or refuses it whole.
   * The change must describe current rows: a delete or update of a row this
   * Workspace does not hold, or an insert over an existing id, is a conflict.
   */
  applyChange(input: CatalogChangeInput): Promise<CommitChangeResult> {
    return this.exclusive(async () => {
      const workspace = await this.store.getWorkspace(input.workspaceId);
      if (!workspace) {
        return { kind: "workspace-not-found" };
      }
      const current = await this.store.listEntries(workspace.id);
      const next = nextCatalog(workspace.id, current, input.change);
      if (typeof next === "string") {
        return { kind: "conflict", reason: next };
      }
      try {
        storageTree(next.values());
      } catch (error) {
        return { kind: "conflict", reason: String(error) };
      }

      const { change } = input;
      await this.store.commit({
        deleteEntries: change.deleted.map((entry) => entry.id),
        putEntries: [...change.updated, ...change.inserted],
        workspace: {
          ...workspace,
          ...(input.updatedAt === undefined
            ? {}
            : { updatedAt: input.updatedAt }),
          ...(input.lastReconciledAt === undefined
            ? {}
            : {
                lastReconciledAt: nextWorkspaceObservation(
                  workspace.lastReconciledAt,
                  input.lastReconciledAt
                ),
              }),
        },
      });
      const byId = new Map(current.map((entry) => [entry.id, entry]));
      this.publish([
        ...change.deleted.map((entry) => ({
          action: "delete" as const,
          entry: byId.get(entry.id) ?? entry,
        })),
        ...change.updated.map((entry) => ({
          action: "change" as const,
          entry,
        })),
        ...change.inserted.map((entry) => ({ action: "add" as const, entry })),
      ]);
      return { kind: "committed" };
    });
  }

  rename(
    workspaceId: WorkspaceId,
    name: string,
    updatedAt: Date
  ): Promise<WorkspaceRegistration | null> {
    return this.exclusive(async () => {
      const workspace = await this.store.getWorkspace(workspaceId);
      if (!workspace || workspace.name === name) {
        return workspace;
      }
      const renamed = { ...workspace, name, updatedAt };
      await this.store.commit({ workspace: renamed });
      return renamed;
    });
  }

  /** Forgets one Workspace and its catalog; the source is never touched. */
  remove(workspaceId: WorkspaceId): Promise<RemoveWorkspaceResult> {
    return this.exclusive(async () => {
      if (!(await this.store.getWorkspace(workspaceId))) {
        return { kind: "not-found" };
      }
      const entries = await this.store.listEntries(workspaceId);
      await this.store.removeWorkspace(workspaceId);
      this.publish(entries.map((entry) => ({ action: "delete", entry })));
      return { kind: "removed" };
    });
  }

  /**
   * Root first, then source reference — not one pass testing both. A
   * candidate can collide with one incumbent on its root and another on its
   * reference, and the root's owner is the answer either way.
   */
  private async claimant(
    workspace: WorkspaceRegistration
  ): Promise<WorkspaceRegistration | null> {
    const byPath = await this.store.findWorkspaceByPath(workspace.source.path);
    if (byPath || workspace.source.sourceId === null) {
      return byPath;
    }
    return this.store.findWorkspaceBySourceId(workspace.source.sourceId);
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/** The catalog after `change`, or why it cannot apply. */
function nextCatalog(
  workspaceId: WorkspaceId,
  current: readonly WorkspaceEntry[],
  change: WorkspaceCatalogChange
): Map<WorkspaceEntryId, WorkspaceEntry> | string {
  const next = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of change.deleted) {
    if (!next.delete(entry.id)) {
      return `Entry ${entry.id} is not in Workspace ${workspaceId}`;
    }
  }
  for (const entry of change.updated) {
    if (entry.workspaceId !== workspaceId || !next.has(entry.id)) {
      return `Entry ${entry.id} is not in Workspace ${workspaceId}`;
    }
    next.set(entry.id, entry);
  }
  for (const entry of change.inserted) {
    if (entry.workspaceId !== workspaceId || next.has(entry.id)) {
      return `Entry ${entry.id} cannot join Workspace ${workspaceId}`;
    }
    next.set(entry.id, entry);
  }
  return next;
}
