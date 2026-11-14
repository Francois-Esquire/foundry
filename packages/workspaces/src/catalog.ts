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
 * store holds still holds when the write lands. Across catalogs over one
 * store, that holds when the store offers `transaction`; without it, a second
 * catalog can still interleave.
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

  create(input: {
    readonly workspace: WorkspaceRegistration;
    readonly entries: readonly WorkspaceEntry[];
  }): Promise<CommitCreateResult> {
    return this.mutation<CommitCreateResult>(async (store) => {
      const { workspace, entries } = input;
      const incumbent = await claimant(store, workspace);
      if (incumbent) {
        return {
          result: { existingId: incumbent.id, kind: "workspace-exists" },
        };
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
      await store.commit({ putEntries: entries, workspace });
      return {
        changes: entries.map((entry) => ({ action: "add", entry })),
        result: { kind: "committed" },
      };
    });
  }

  /**
   * Applies one change against the catalog as it stands, or refuses it whole.
   * The change must describe current rows: a delete or update of a row this
   * Workspace does not hold, or an insert over an existing id, is a conflict.
   */
  applyChange(input: CatalogChangeInput): Promise<CommitChangeResult> {
    return this.mutation<CommitChangeResult>(async (store) => {
      const workspace = await store.getWorkspace(input.workspaceId);
      if (!workspace) {
        return { result: { kind: "workspace-not-found" } };
      }
      const current = await store.listEntries(workspace.id);
      const next = nextCatalog(workspace.id, current, input.change);
      if (typeof next === "string") {
        return { result: { kind: "conflict", reason: next } };
      }
      try {
        storageTree(next.values());
      } catch (error) {
        return { result: { kind: "conflict", reason: String(error) } };
      }

      const { change } = input;
      await store.commit({
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
      return {
        changes: [
          ...change.deleted.map((entry) => ({
            action: "delete" as const,
            entry: byId.get(entry.id) ?? entry,
          })),
          ...change.updated.map((entry) => ({
            action: "change" as const,
            entry,
          })),
          ...change.inserted.map((entry) => ({
            action: "add" as const,
            entry,
          })),
        ],
        result: { kind: "committed" },
      };
    });
  }

  rename(
    workspaceId: WorkspaceId,
    name: string,
    updatedAt: Date
  ): Promise<WorkspaceRegistration | null> {
    return this.mutation<WorkspaceRegistration | null>(async (store) => {
      const workspace = await store.getWorkspace(workspaceId);
      if (!workspace || workspace.name === name) {
        return { result: workspace };
      }
      const renamed = { ...workspace, name, updatedAt };
      await store.commit({ workspace: renamed });
      return { result: renamed };
    });
  }

  /** Forgets one Workspace and its catalog; the source is never touched. */
  remove(workspaceId: WorkspaceId): Promise<RemoveWorkspaceResult> {
    return this.mutation<RemoveWorkspaceResult>(async (store) => {
      if (!(await store.getWorkspace(workspaceId))) {
        return { result: { kind: "not-found" } };
      }
      const entries = await store.listEntries(workspaceId);
      await store.commit({
        deleteEntries: entries.map((entry) => entry.id),
        removeWorkspace: workspaceId,
      });
      return {
        changes: entries.map((entry) => ({ action: "delete", entry })),
        result: { kind: "removed" },
      };
    });
  }

  /**
   * One read-modify-write: serialized in this catalog, and exclusive in the
   * store when it offers transactions, so another catalog over the same store
   * cannot write between the reads and the commit. Changes are published once
   * the write has landed, outside the store's transaction.
   */
  private mutation<T>(
    work: (store: WorkspaceStore) => Promise<Mutation<T>>
  ): Promise<T> {
    return this.serialized(async () => {
      const { changes, result } = await this.transaction(work);
      if (changes) {
        this.publish(changes);
      }
      return result;
    });
  }

  private transaction<T>(
    work: (store: WorkspaceStore) => Promise<T>
  ): Promise<T> {
    const { store } = this;
    return store.transaction === undefined
      ? work(store)
      : store.transaction(work);
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/** What one mutation answers, and the changes it publishes once committed. */
interface Mutation<T> {
  readonly changes?: readonly WorkspaceChange[];
  readonly result: T;
}

/**
 * Root first, then source reference — not one pass testing both. A
 * candidate can collide with one incumbent on its root and another on its
 * reference, and the root's owner is the answer either way.
 */
async function claimant(
  store: WorkspaceStore,
  workspace: WorkspaceRegistration
): Promise<WorkspaceRegistration | null> {
  const byPath = await store.findWorkspaceByPath(workspace.source.path);
  if (byPath || workspace.source.sourceId === null) {
    return byPath;
  }
  return store.findWorkspaceBySourceId(workspace.source.sourceId);
}

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
