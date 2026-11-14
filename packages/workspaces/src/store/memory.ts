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
 * The default store: plain maps in this process. Writes and transactions run
 * one at a time, so a write from outside a transaction waits for it to end.
 */
export class MemoryWorkspaceStore implements WorkspaceStore {
  private readonly workspaces = new Map<WorkspaceId, WorkspaceRegistration>();
  private readonly entries = new Map<
    WorkspaceId,
    Map<WorkspaceEntryId, WorkspaceEntry>
  >();
  private tail: Promise<void> = Promise.resolve();

  commit(write: WorkspaceStoreWrite): Promise<void> {
    return this.queued(() => this.apply(write));
  }

  transaction<T>(work: (view: WorkspaceStore) => Promise<T>): Promise<T> {
    return this.queued(async () => {
      let open = true;
      const view: WorkspaceStore = {
        commit: (write) =>
          open
            ? this.apply(write)
            : Promise.reject(new Error("This transaction has ended")),
        findWorkspaceByPath: (path) => this.findWorkspaceByPath(path),
        findWorkspaceBySourceId: (sourceId) =>
          this.findWorkspaceBySourceId(sourceId),
        getEntry: (workspaceId, entryId) => this.getEntry(workspaceId, entryId),
        getWorkspace: (workspaceId) => this.getWorkspace(workspaceId),
        listEntries: (workspaceId) => this.listEntries(workspaceId),
        listWorkspaces: (input) => this.listWorkspaces(input),
      };
      try {
        return await work(view);
      } finally {
        open = false;
      }
    });
  }

  // Async, and clones first, so a write holding a value that cannot be cloned
  // rejects whole instead of throwing partway.
  private async apply(write: WorkspaceStoreWrite): Promise<void> {
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

  getWorkspace(
    workspaceId: WorkspaceId
  ): Promise<WorkspaceRegistration | null> {
    const workspace = this.workspaces.get(workspaceId);
    return Promise.resolve(workspace ? structuredClone(workspace) : null);
  }

  findWorkspaceByPath(path: string): Promise<WorkspaceRegistration | null> {
    return this.oldest((workspace) => workspace.source.path === path);
  }

  findWorkspaceBySourceId(
    sourceId: string
  ): Promise<WorkspaceRegistration | null> {
    return this.oldest((workspace) => workspace.source.sourceId === sourceId);
  }

  listWorkspaces(
    input: PageInput<number> = {}
  ): Promise<Page<WorkspaceRegistration, number>> {
    const page = sliceRanked(
      this.ordered(),
      pageLimit(input.limit),
      input.cursor ?? 0
    );
    return Promise.resolve({
      ...page,
      items: page.items.map((workspace) => structuredClone(workspace)),
    });
  }

  getEntry(
    workspaceId: WorkspaceId,
    entryId: WorkspaceEntryId
  ): Promise<WorkspaceEntry | null> {
    const entry = this.entries.get(workspaceId)?.get(entryId);
    return Promise.resolve(entry ? structuredClone(entry) : null);
  }

  listEntries(workspaceId: WorkspaceId): Promise<readonly WorkspaceEntry[]> {
    const entries = [...(this.entries.get(workspaceId)?.values() ?? [])];
    return Promise.resolve(
      entries
        .sort(byCodeUnit((entry) => entry.path))
        .map((entry) => structuredClone(entry))
    );
  }

  private queued<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private oldest(
    matches: (workspace: WorkspaceRegistration) => boolean
  ): Promise<WorkspaceRegistration | null> {
    const found = this.ordered().find(matches);
    return Promise.resolve(found ? structuredClone(found) : null);
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
