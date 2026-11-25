import type { Page, PageInput } from "@foundry/core/pagination";
import { storageTree } from "@foundry/core/storage";
import { nextWorkspaceObservation } from "./observation";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceEvent,
  WorkspaceId,
  WorkspaceRegistration,
} from "./schema";
import type { WorkspaceStore } from "./store";

export interface WorkspaceChange {
  readonly action: "add" | "change" | "delete";
  readonly entry: WorkspaceEntry;
}

export interface WorkspaceCatalogChange {
  readonly deleted: readonly WorkspaceEntry[];
  readonly inserted: readonly WorkspaceEntry[];
  readonly updated: readonly WorkspaceEntry[];
}

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
  readonly lastReconciledAt?: Date;
  readonly updatedAt?: Date;
  readonly workspaceId: WorkspaceId;
}

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
    const eventId = crypto.randomUUID();
    return this.mutation<CommitCreateResult>(async (store) => {
      const { workspace, entries } = input;
      const incumbent =
        (await store.getWorkspace(workspace.id)) ??
        (await claimant(store, workspace));
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
      await store.commit({
        events: [
          {
            at: workspace.createdAt.toISOString(),
            id: eventId,
            type: "workspace.created",
            workspaceId: workspace.id,
          },
        ],
        putEntries: entries,
        workspace,
      });
      return {
        changes: entries.map((entry) => ({ action: "add", entry })),
        result: { kind: "committed" },
      };
    });
  }

  applyChange(input: CatalogChangeInput): Promise<CommitChangeResult> {
    const eventId = crypto.randomUUID();
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

      const effect = effectOf(current, next, input.change);
      const touched =
        effect.deleted.length + effect.updated.length + effect.inserted.length >
        0;
      const saved: WorkspaceRegistration = {
        ...workspace,
        ...(input.updatedAt === undefined || !touched
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
      };
      const changed = touched
        ? entriesChanged(
            eventId,
            workspace.id,
            input.updatedAt ?? new Date(),
            effect
          )
        : undefined;
      await store.commit({
        deleteEntries: effect.deleted.map((entry) => entry.id),
        ...(changed === undefined ? {} : { events: [changed] }),
        putEntries: [...effect.updated, ...effect.inserted],
        workspace: saved,
      });
      return {
        changes: [
          ...effect.deleted.map((entry) => ({
            action: "delete" as const,
            entry,
          })),
          ...effect.updated.map((entry) => ({
            action: "change" as const,
            entry,
          })),
          ...effect.inserted.map((entry) => ({
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
    const eventId = crypto.randomUUID();
    return this.mutation<WorkspaceRegistration | null>(async (store) => {
      const workspace = await store.getWorkspace(workspaceId);
      if (!workspace || workspace.name === name) {
        return { result: workspace };
      }
      const renamed = { ...workspace, name, updatedAt };
      await store.commit({
        events: [
          {
            at: updatedAt.toISOString(),
            id: eventId,
            type: "workspace.updated",
            workspaceId,
          },
        ],
        workspace: renamed,
      });
      return { result: renamed };
    });
  }

  remove(workspaceId: WorkspaceId): Promise<RemoveWorkspaceResult> {
    const eventId = crypto.randomUUID();
    return this.mutation<RemoveWorkspaceResult>(async (store) => {
      if (!(await store.getWorkspace(workspaceId))) {
        return { result: { kind: "not-found" } };
      }
      const entries = await store.listEntries(workspaceId);
      await store.commit({
        events: [
          {
            at: new Date().toISOString(),
            id: eventId,
            type: "workspace.removed",
            workspaceId,
          },
        ],
        removeWorkspace: workspaceId,
      });
      return {
        changes: entries.map((entry) => ({ action: "delete", entry })),
        result: { kind: "removed" },
      };
    });
  }

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

function effectOf(
  current: readonly WorkspaceEntry[],
  next: ReadonlyMap<WorkspaceEntryId, WorkspaceEntry>,
  change: WorkspaceCatalogChange
): WorkspaceCatalogChange {
  const stored = new Map(current.map((entry) => [entry.id, entry]));
  const deleted = new Map<WorkspaceEntryId, WorkspaceEntry>();
  for (const { id } of change.deleted) {
    const entry = stored.get(id);
    if (entry !== undefined && !next.has(id)) {
      deleted.set(id, entry);
    }
  }
  const updated = new Map<WorkspaceEntryId, WorkspaceEntry>();
  const inserted = new Map<WorkspaceEntryId, WorkspaceEntry>();
  for (const { id } of [...change.updated, ...change.inserted]) {
    const entry = next.get(id);
    const before = stored.get(id);
    if (entry === undefined || updated.has(id) || inserted.has(id)) {
      continue;
    }
    if (before === undefined) {
      inserted.set(id, entry);
    } else if (!sameEntry(before, entry)) {
      updated.set(id, entry);
    }
  }
  return {
    deleted: [...deleted.values()],
    inserted: [...inserted.values()],
    updated: [...updated.values()],
  };
}

function sameEntry(a: WorkspaceEntry, b: WorkspaceEntry): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  return keys.every((key) => {
    const left: unknown = Reflect.get(a, key);
    const right: unknown = Reflect.get(b, key);
    if (left instanceof Date && right instanceof Date) {
      return left.getTime() === right.getTime();
    }
    return Object.hasOwn(b, key) && Object.is(left, right);
  });
}

function entriesChanged(
  id: string,
  workspaceId: WorkspaceId,
  at: Date,
  change: WorkspaceCatalogChange
): WorkspaceEvent | undefined {
  const ids = (entries: readonly WorkspaceEntry[]) =>
    entries.map((entry) => entry.id);
  const added = ids(change.inserted);
  const changed = ids(change.updated);
  const removed = ids(change.deleted);
  if (added.length + changed.length + removed.length === 0) {
    return;
  }
  return {
    added,
    at: at.toISOString(),
    changed,
    id,
    removed,
    type: "workspace.entries.changed",
    workspaceId,
  };
}

interface Mutation<T> {
  readonly changes?: readonly WorkspaceChange[];
  readonly result: T;
}

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
