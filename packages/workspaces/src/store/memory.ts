import type { Page, PageInput } from "@foundry/core/pagination";
import { pageLimit, sliceRanked } from "@foundry/lib/pagination";
import { Turns } from "@foundry/lib/turns";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceId,
  WorkspaceRegistration,
} from "../types";
import type { WorkspaceStore, WorkspaceStoreWrite } from "./index";
import { byCodePoint, byPathThenId, pageOffset } from "./order";

/** Why a call from inside the store's own transaction is refused. */
const REENTRY =
  "MemoryWorkspaceStore was called from inside its own transaction; use the view passed to the transaction's work instead";

/**
 * The default store: plain maps in this process. Every call takes a turn, so
 * a commit made while a transaction runs lands after it, and a call made from
 * inside a transaction's work is refused. A transaction works on a staged
 * copy of the maps that replaces them only when its work succeeds.
 */
export class MemoryWorkspaceStore implements WorkspaceStore {
  private storage = new Storage();
  private readonly turns = new Turns(REENTRY);

  commit(write: WorkspaceStoreWrite): Promise<void> {
    return this.inTurn((storage) => storage.apply(write));
  }

  transaction<T>(work: (view: WorkspaceStore) => Promise<T>): Promise<T> {
    return this.turns.run(async () => {
      const staged = this.storage.copy();
      let open = true;
      const onStaged = <R>(answer: (storage: Storage) => R): Promise<R> =>
        new Promise((resolve) => resolve(answer(staged)));
      const view: WorkspaceStore = {
        commit: (write) =>
          onStaged((storage) => {
            if (!open) {
              throw new Error("This transaction has ended");
            }
            storage.apply(write);
          }),
        findWorkspaceByPath: (path) =>
          onStaged((storage) => storage.findWorkspaceByPath(path)),
        findWorkspaceBySourceId: (sourceId) =>
          onStaged((storage) => storage.findWorkspaceBySourceId(sourceId)),
        getEntry: (workspaceId, entryId) =>
          onStaged((storage) => storage.getEntry(workspaceId, entryId)),
        getWorkspace: (workspaceId) =>
          onStaged((storage) => storage.getWorkspace(workspaceId)),
        listEntries: (workspaceId) =>
          onStaged((storage) => storage.listEntries(workspaceId)),
        listWorkspaces: (input) =>
          onStaged((storage) => storage.listWorkspaces(input)),
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
    return this.inTurn((storage) => storage.getWorkspace(workspaceId));
  }

  findWorkspaceByPath(path: string): Promise<WorkspaceRegistration | null> {
    return this.inTurn((storage) => storage.findWorkspaceByPath(path));
  }

  findWorkspaceBySourceId(
    sourceId: string
  ): Promise<WorkspaceRegistration | null> {
    return this.inTurn((storage) => storage.findWorkspaceBySourceId(sourceId));
  }

  listWorkspaces(
    input?: PageInput<number>
  ): Promise<Page<WorkspaceRegistration, number>> {
    return this.inTurn((storage) => storage.listWorkspaces(input));
  }

  getEntry(
    workspaceId: WorkspaceId,
    entryId: WorkspaceEntryId
  ): Promise<WorkspaceEntry | null> {
    return this.inTurn((storage) => storage.getEntry(workspaceId, entryId));
  }

  listEntries(workspaceId: WorkspaceId): Promise<readonly WorkspaceEntry[]> {
    return this.inTurn((storage) => storage.listEntries(workspaceId));
  }

  /** One turn over the maps as they stand when the turn comes. */
  private inTurn<R>(answer: (storage: Storage) => R): Promise<R> {
    return this.turns.run(
      () => new Promise((resolve) => resolve(answer(this.storage)))
    );
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

  /**
   * Deletes the named entries of the write's Workspace, then files each put
   * under its own `workspaceId`. Clones first, so a write holding a value
   * that cannot be cloned changes nothing.
   */
  apply(write: WorkspaceStoreWrite): void {
    const workspace =
      write.workspace === undefined ? null : structuredClone(write.workspace);
    const workspaceId =
      write.workspace === undefined
        ? write.removeWorkspace
        : write.workspace.id;
    const puts = (write.putEntries ?? []).map((entry) =>
      structuredClone(entry)
    );
    const changed = new Map<
      WorkspaceId,
      Map<WorkspaceEntryId, WorkspaceEntry>
    >();
    const entriesOf = (id: WorkspaceId) => {
      const found = changed.get(id) ?? new Map(this.entries.get(id));
      changed.set(id, found);
      return found;
    };
    const owned = entriesOf(workspaceId);
    for (const id of write.deleteEntries ?? []) {
      owned.delete(id);
    }
    for (const entry of puts) {
      entriesOf(entry.workspaceId).set(entry.id, entry);
    }
    if (workspace) {
      this.workspaces.set(workspaceId, workspace);
    } else {
      this.workspaces.delete(workspaceId);
    }
    for (const [id, entries] of changed) {
      if (entries.size > 0) {
        this.entries.set(id, entries);
      } else {
        this.entries.delete(id);
      }
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
      pageOffset(input.cursor)
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
      .sort(byPathThenId)
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

function byCreatedAtThenId(
  a: WorkspaceRegistration,
  b: WorkspaceRegistration
): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime === 0 ? byCodePoint(a.id, b.id) : byTime;
}
