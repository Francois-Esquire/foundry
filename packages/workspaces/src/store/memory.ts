import type { Page, PageInput } from "@foundry/core/pagination";
import { pageLimit, sliceRanked } from "@foundry/lib/pagination";
import { Turns } from "@foundry/lib/turns";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceId,
  WorkspaceRegistration,
} from "../types";
import type {
  WorkspaceSave,
  WorkspaceStore,
  WorkspaceStoreWrite,
} from "./index";
import { byCodePoint, byPathThenId, pageInputOf, pageOffset } from "./order";

const REENTRY =
  "MemoryWorkspaceStore was called from inside its own transaction; use the view passed to the transaction's work instead";

export class MemoryWorkspaceStore implements WorkspaceStore {
  private storage = new Storage();
  private readonly turns = new Turns(REENTRY);

  commit(write: WorkspaceStoreWrite): Promise<void> {
    return withOwnCopy(write, (copy) =>
      this.inTurn((storage) => storage.apply(copy))
    );
  }

  transaction<T>(work: (view: WorkspaceStore) => Promise<T>): Promise<T> {
    return this.turns.run(async () => {
      const staged = this.storage.copy();
      let open = true;
      const onStaged = <R>(answer: (storage: Storage) => R): Promise<R> =>
        new Promise((resolve) => resolve(answer(staged)));
      const view: WorkspaceStore = {
        commit: (write) =>
          withOwnCopy(write, (copy) =>
            onStaged((storage) => {
              if (!open) {
                throw new Error("This transaction has ended");
              }
              storage.apply(copy);
            })
          ),
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
    let query: PageInput<number>;
    try {
      query = pageInputOf(input);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.inTurn((storage) => storage.listWorkspaces(query));
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

  private inTurn<R>(answer: (storage: Storage) => R): Promise<R> {
    return this.turns.run(
      () => new Promise((resolve) => resolve(answer(this.storage)))
    );
  }
}

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

  apply(write: WorkspaceStoreWrite): void {
    if (write.workspace === undefined) {
      this.workspaces.delete(write.removeWorkspace);
      this.entries.delete(write.removeWorkspace);
    } else {
      this.save(write);
    }
  }

  private save(write: WorkspaceSave): void {
    const { workspace } = write;
    const puts = write.putEntries ?? [];
    const changed = new Map<
      WorkspaceId,
      Map<WorkspaceEntryId, WorkspaceEntry>
    >();
    const entriesOf = (id: WorkspaceId) => {
      const found = changed.get(id) ?? new Map(this.entries.get(id));
      changed.set(id, found);
      return found;
    };
    const owned = entriesOf(workspace.id);
    for (const id of write.deleteEntries ?? []) {
      owned.delete(id);
    }
    for (const entry of puts) {
      entriesOf(entry.workspaceId).set(entry.id, entry);
    }
    this.workspaces.set(workspace.id, workspace);
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

function withOwnCopy(
  write: WorkspaceStoreWrite,
  take: (copy: WorkspaceStoreWrite) => Promise<void>
): Promise<void> {
  let copy: WorkspaceStoreWrite;
  try {
    copy = structuredClone(write);
  } catch (error) {
    return Promise.reject(error);
  }
  return take(copy);
}

function byCreatedAtThenId(
  a: WorkspaceRegistration,
  b: WorkspaceRegistration
): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime === 0 ? byCodePoint(a.id, b.id) : byTime;
}
