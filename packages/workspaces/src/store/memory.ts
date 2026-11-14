import type { Page, PageInput } from "@foundry/core/pagination";
import { byCodeUnit } from "@foundry/lib/ordering";
import { pageLimit, sliceRanked } from "@foundry/lib/pagination";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceId,
  WorkspaceRegistration,
} from "../types";
import type { WorkspaceStore, WorkspaceStoreWrite } from "./index";

/**
 * The default store: plain maps in this process. Commits and transactions
 * take turns in one queue, so a commit from outside a transaction waits for
 * it to end. A transaction works on a staged copy of the maps that replaces
 * them only when its work succeeds.
 */
export class MemoryWorkspaceStore implements WorkspaceStore {
  private storage = new Storage();
  private tail: Promise<void> = Promise.resolve();

  commit(write: WorkspaceStoreWrite): Promise<void> {
    return this.queued(() => this.storage.apply(write));
  }

  transaction<T>(work: (view: WorkspaceStore) => Promise<T>): Promise<T> {
    return this.queued(async () => {
      const staged = this.storage.copy();
      let open = true;
      const view: WorkspaceStore = {
        commit: (write) =>
          new Promise((resolve) => {
            if (!open) {
              throw new Error("This transaction has ended");
            }
            resolve(staged.apply(write));
          }),
        findWorkspaceByPath: (path) =>
          Promise.resolve(staged.findWorkspaceByPath(path)),
        findWorkspaceBySourceId: (sourceId) =>
          Promise.resolve(staged.findWorkspaceBySourceId(sourceId)),
        getEntry: (workspaceId, entryId) =>
          Promise.resolve(staged.getEntry(workspaceId, entryId)),
        getWorkspace: (workspaceId) =>
          Promise.resolve(staged.getWorkspace(workspaceId)),
        listEntries: (workspaceId) =>
          Promise.resolve(staged.listEntries(workspaceId)),
        listWorkspaces: (input) =>
          Promise.resolve(staged.listWorkspaces(input)),
      };
      try {
        const result = await work(view);
        this.storage = staged;
        return result;
      } finally {
        open = false;
      }
    });
  }

  getWorkspace(
    workspaceId: WorkspaceId
  ): Promise<WorkspaceRegistration | null> {
    return Promise.resolve(this.storage.getWorkspace(workspaceId));
  }

  findWorkspaceByPath(path: string): Promise<WorkspaceRegistration | null> {
    return Promise.resolve(this.storage.findWorkspaceByPath(path));
  }

  findWorkspaceBySourceId(
    sourceId: string
  ): Promise<WorkspaceRegistration | null> {
    return Promise.resolve(this.storage.findWorkspaceBySourceId(sourceId));
  }

  listWorkspaces(
    input?: PageInput<number>
  ): Promise<Page<WorkspaceRegistration, number>> {
    return Promise.resolve(this.storage.listWorkspaces(input));
  }

  getEntry(
    workspaceId: WorkspaceId,
    entryId: WorkspaceEntryId
  ): Promise<WorkspaceEntry | null> {
    return Promise.resolve(this.storage.getEntry(workspaceId, entryId));
  }

  listEntries(workspaceId: WorkspaceId): Promise<readonly WorkspaceEntry[]> {
    return Promise.resolve(this.storage.listEntries(workspaceId));
  }

  private queued<T>(work: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/**
 * The maps one store holds. A write never changes an entry map in place, so
 * a copy of the two outer maps is a full, independent snapshot.
 */
class Storage {
  private readonly workspaces: Map<WorkspaceId, WorkspaceRegistration>;
  private readonly entries: Map<
    WorkspaceId,
    ReadonlyMap<WorkspaceEntryId, WorkspaceEntry>
  >;

  constructor(
    workspaces = new Map<WorkspaceId, WorkspaceRegistration>(),
    entries = new Map<
      WorkspaceId,
      ReadonlyMap<WorkspaceEntryId, WorkspaceEntry>
    >()
  ) {
    this.workspaces = workspaces;
    this.entries = entries;
  }

  copy(): Storage {
    return new Storage(new Map(this.workspaces), new Map(this.entries));
  }

  /** Clones first, so a write holding a value that cannot be cloned changes nothing. */
  apply(write: WorkspaceStoreWrite): void {
    const workspace =
      write.workspace === undefined ? null : structuredClone(write.workspace);
    const workspaceId =
      write.workspace === undefined
        ? write.removeWorkspace
        : write.workspace.id;
    const puts = (write.putEntries ?? []).map(
      (entry): [WorkspaceEntryId, WorkspaceEntry] => [
        entry.id,
        structuredClone(entry),
      ]
    );
    const entries = new Map(this.entries.get(workspaceId));
    for (const id of write.deleteEntries ?? []) {
      entries.delete(id);
    }
    for (const [id, entry] of puts) {
      entries.set(id, entry);
    }
    if (workspace) {
      this.workspaces.set(workspaceId, workspace);
    } else {
      this.workspaces.delete(workspaceId);
    }
    if (entries.size > 0) {
      this.entries.set(workspaceId, entries);
    } else {
      this.entries.delete(workspaceId);
    }
  }

  getWorkspace(workspaceId: WorkspaceId): WorkspaceRegistration | null {
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? structuredClone(workspace) : null;
  }

  findWorkspaceByPath(path: string): WorkspaceRegistration | null {
    return this.oldest((workspace) => workspace.source.path === path);
  }

  findWorkspaceBySourceId(sourceId: string): WorkspaceRegistration | null {
    return this.oldest((workspace) => workspace.source.sourceId === sourceId);
  }

  listWorkspaces(
    input: PageInput<number> = {}
  ): Page<WorkspaceRegistration, number> {
    const page = sliceRanked(
      this.ordered(),
      pageLimit(input.limit),
      input.cursor ?? 0
    );
    return {
      ...page,
      items: page.items.map((workspace) => structuredClone(workspace)),
    };
  }

  getEntry(
    workspaceId: WorkspaceId,
    entryId: WorkspaceEntryId
  ): WorkspaceEntry | null {
    const entry = this.entries.get(workspaceId)?.get(entryId);
    return entry ? structuredClone(entry) : null;
  }

  listEntries(workspaceId: WorkspaceId): readonly WorkspaceEntry[] {
    return [...(this.entries.get(workspaceId)?.values() ?? [])]
      .sort(byCodeUnit((entry) => entry.path))
      .map((entry) => structuredClone(entry));
  }

  private oldest(
    matches: (workspace: WorkspaceRegistration) => boolean
  ): WorkspaceRegistration | null {
    const found = this.ordered().find(matches);
    return found ? structuredClone(found) : null;
  }

  private ordered(): WorkspaceRegistration[] {
    return [...this.workspaces.values()].sort(byCreatedAtThenId);
  }
}

const byId = byCodeUnit((workspace: WorkspaceRegistration) => workspace.id);

function byCreatedAtThenId(
  a: WorkspaceRegistration,
  b: WorkspaceRegistration
): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime === 0 ? byId(a, b) : byTime;
}
