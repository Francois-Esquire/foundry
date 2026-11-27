import type { Page, PageInput } from "@foundry/core/pagination";
import { pageLimit, sliceRanked } from "@foundry/lib/pagination";
import { ownedWrite } from "@foundry/lib/plain-json";
import { Turns } from "@foundry/lib/turns";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceId,
  WorkspaceRegistration,
} from "../schema";
import type {
  EntryCountQuery,
  EntryPageQuery,
  WorkspaceSave,
  WorkspaceStore,
  WorkspaceStoreWrite,
} from "./index";
import {
  byCodePoint,
  byCodePointPathThenId,
  byPathThenId,
  entryCountQueryOf,
  entryPageQueryOf,
  pageInputOf,
  pageOffset,
} from "./order";

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
        countEntries: (workspaceId, query) => {
          let owned: EntryCountQuery;
          try {
            owned = entryCountQueryOf(query);
          } catch (error) {
            return Promise.reject(error);
          }
          return onStaged((storage) =>
            storage.countEntries(workspaceId, owned)
          );
        },
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
        listEntriesPage: (workspaceId, input) => {
          let query: EntryPageQuery;
          try {
            query = entryPageQueryOf(input);
          } catch (error) {
            return Promise.reject(error);
          }
          return onStaged((storage) =>
            storage.listEntriesPage(workspaceId, query)
          );
        },
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

  listEntriesPage(
    workspaceId: WorkspaceId,
    input?: EntryPageQuery
  ): Promise<Page<WorkspaceEntry, number>> {
    let query: EntryPageQuery;
    try {
      query = entryPageQueryOf(input);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.inTurn((storage) =>
      storage.listEntriesPage(workspaceId, query)
    );
  }

  countEntries(
    workspaceId: WorkspaceId,
    query?: EntryCountQuery
  ): Promise<number> {
    let owned: EntryCountQuery;
    try {
      owned = entryCountQueryOf(query);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.inTurn((storage) => storage.countEntries(workspaceId, owned));
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

  listEntriesPage(
    workspaceId: WorkspaceId,
    input: EntryPageQuery = {}
  ): Page<WorkspaceEntry, number> {
    const limit = pageLimit(input.limit);
    const offset = pageOffset(input.cursor);
    const ranked = [...(this.entries.get(workspaceId)?.values() ?? [])]
      .filter((entry) => input.type === undefined || entry.type === input.type)
      .sort(byCodePointPathThenId);
    const page = sliceRanked(ranked, limit, offset);
    return {
      ...page,
      items: page.items.map((entry) => structuredClone(entry)),
    };
  }

  countEntries(workspaceId: WorkspaceId, query: EntryCountQuery = {}): number {
    const bucket = this.entries.get(workspaceId);
    if (bucket === undefined) {
      return 0;
    }
    if (query.type === undefined) {
      return bucket.size;
    }
    let total = 0;
    for (const entry of bucket.values()) {
      if (entry.type === query.type) {
        total += 1;
      }
    }
    return total;
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
    copy = ownedWrite(write);
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
