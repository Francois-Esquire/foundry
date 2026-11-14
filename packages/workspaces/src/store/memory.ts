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

  /**
   * Takes the write as it stands now: one `structuredClone` of it, made
   * before the commit waits its turn, so a caller changing the write later
   * changes nothing. A write the clone refuses rejects whole and changes
   * nothing. A transaction's view takes its writes the same way.
   */
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

  /** Reads `input` when called; see {@link pageInputOf}. */
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

  /** Applies `write`, the store's own copy, which the maps then hold. */
  apply(write: WorkspaceStoreWrite): void {
    if (write.workspace === undefined) {
      this.workspaces.delete(write.removeWorkspace);
      this.entries.delete(write.removeWorkspace);
    } else {
      this.save(write);
    }
  }

  /**
   * Deletes the named entries of the saved Workspace, then files each put
   * under its own `workspaceId`.
   */
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

/**
 * `take` with the store's own copy of `write`, or a rejection when the
 * write cannot be cloned.
 */
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
