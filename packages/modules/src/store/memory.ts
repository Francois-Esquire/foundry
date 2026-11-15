import type { ContentId } from "@foundry/artifacts";
import { Turns } from "@foundry/lib/turns";

import type { InstallationId, ModuleId } from "../domain";
import type {
  InstallationListQuery,
  ManifestListQuery,
  Module,
  ModuleListQuery,
  ModuleStore,
  ModuleStorePage,
  ModuleStorePageQuery,
  ModuleStoreWrite,
  StoredInstallation,
  StoredManifest,
} from "../store";
import { ownedQuery } from "./query";

/** Why a call from inside the store's own transaction is refused. */
const REENTRY =
  "MemoryModuleStore was called from inside its own transaction; use the view passed to the transaction's work instead";

/** Why a view used after its transaction settled is refused. */
const ENDED =
  "MemoryModuleStore transaction view was used after its transaction settled";

/**
 * The default store: plain maps in this process. Reads list records in the
 * order they were first put; a put over a stored record keeps its place.
 * Every call takes a turn, so a commit made while a transaction runs lands
 * after it, and a call made from inside a transaction's work is refused.
 *
 * A transaction stages its commits on a copy of the store's tables, taken
 * at its first commit, and swaps the copy in only if its work succeeds.
 */
export class MemoryModuleStore implements ModuleStore {
  #tables = new Tables();
  readonly #turns = new Turns(REENTRY);

  /**
   * Takes the write as it stands now: one `structuredClone` of it, made
   * before the commit waits its turn, so a caller changing the write later
   * changes nothing. A write the clone refuses rejects whole and changes
   * nothing. A transaction's view commits the same way.
   */
  commit(write: ModuleStoreWrite): Promise<void> {
    let owned: OwnedWrite;
    try {
      owned = ownedWrite(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() => {
      this.#tables.apply(owned);
      return Promise.resolve();
    });
  }

  /**
   * Runs `work` over a view that stages its commits, and keeps them only if
   * `work` succeeds, so a throw after a commit through `view` leaves
   * nothing.
   */
  transaction<T>(work: (view: ModuleStore) => Promise<T>): Promise<T> {
    return this.#turns.run(async () => {
      const view = new MemoryView(this.#tables);
      try {
        const result = await work(view);
        this.#tables = view.tables;
        return result;
      } finally {
        view.end();
      }
    });
  }

  getInstallation(id: InstallationId): Promise<StoredInstallation | null> {
    return this.#read((tables) => tables.getInstallation(id));
  }

  getManifest(contentId: ContentId): Promise<StoredManifest | null> {
    return this.#read((tables) => tables.getManifest(contentId));
  }

  getModule(id: ModuleId): Promise<Module | null> {
    return this.#read((tables) => tables.getModule(id));
  }

  listInstallations(
    query: InstallationListQuery
  ): Promise<ModuleStorePage<StoredInstallation>> {
    return this.#list(query, (tables, owned) =>
      tables.listInstallations(owned)
    );
  }

  listManifests(
    query: ManifestListQuery = {}
  ): Promise<readonly StoredManifest[]> {
    let owned: ManifestListQuery;
    try {
      owned = structuredClone(query);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#read((tables) => tables.listManifests(owned));
  }

  listModules(query: ModuleListQuery): Promise<ModuleStorePage<Module>> {
    return this.#list(query, (tables, owned) => tables.listModules(owned));
  }

  #read<T>(read: (tables: Tables) => T): Promise<T> {
    return this.#turns.run(() => Promise.resolve(read(this.#tables)));
  }

  #list<Q extends ModuleStorePageQuery, T>(
    query: Q,
    read: (tables: Tables, query: Q) => ModuleStorePage<T>
  ): Promise<ModuleStorePage<T>> {
    let owned: Q;
    try {
      owned = ownedQuery(query);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#read((tables) => read(tables, owned));
  }
}

/**
 * A transaction's view: reads see the store's tables until the first
 * commit, which copies them; later commits change only the copy.
 */
class MemoryView implements ModuleStore {
  tables: Tables;
  readonly #base: Tables;
  #ended: boolean;

  constructor(tables: Tables) {
    this.tables = tables;
    this.#base = tables;
    this.#ended = false;
  }

  end(): void {
    this.#ended = true;
  }

  /** Takes its copy of `write` at once, as the store does. */
  commit(write: ModuleStoreWrite): Promise<void> {
    return this.#run(() => {
      const owned = ownedWrite(write);
      if (this.tables === this.#base) {
        this.tables = this.#base.copy();
      }
      this.tables.apply(owned);
    });
  }

  getInstallation(id: InstallationId): Promise<StoredInstallation | null> {
    return this.#run(() => this.tables.getInstallation(id));
  }

  getManifest(contentId: ContentId): Promise<StoredManifest | null> {
    return this.#run(() => this.tables.getManifest(contentId));
  }

  getModule(id: ModuleId): Promise<Module | null> {
    return this.#run(() => this.tables.getModule(id));
  }

  listInstallations(
    query: InstallationListQuery
  ): Promise<ModuleStorePage<StoredInstallation>> {
    return this.#run(() => this.tables.listInstallations(ownedQuery(query)));
  }

  listManifests(
    query: ManifestListQuery = {}
  ): Promise<readonly StoredManifest[]> {
    return this.#run(() => this.tables.listManifests(structuredClone(query)));
  }

  listModules(query: ModuleListQuery): Promise<ModuleStorePage<Module>> {
    return this.#run(() => this.tables.listModules(ownedQuery(query)));
  }

  #run<T>(operation: () => T): Promise<T> {
    if (this.#ended) {
      return Promise.reject(new Error(ENDED));
    }
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

/** A stored record and its place in its table's list order. */
interface Row<T> {
  readonly position: number;
  readonly record: T;
}

/** A write's records, copied so they share nothing with the caller's. */
interface OwnedWrite {
  readonly deleteInstallations: readonly InstallationId[];
  readonly deleteManifests: readonly ContentId[];
  readonly deleteModules: readonly ModuleId[];
  readonly putInstallations: readonly StoredInstallation[];
  readonly putManifests: readonly StoredManifest[];
  readonly putModules: readonly Module[];
}

/** The store's own copy of `write`: one deep copy, which reads the caller's write once. */
function ownedWrite(write: ModuleStoreWrite): OwnedWrite {
  const copy = structuredClone(write);
  return {
    deleteInstallations: copy.deleteInstallations ?? [],
    deleteManifests: copy.deleteManifests ?? [],
    deleteModules: copy.deleteModules ?? [],
    putInstallations: copy.putInstallations ?? [],
    putManifests: copy.putManifests ?? [],
    putModules: copy.putModules ?? [],
  };
}

/** The store's records. Rows are never changed in place, so a copy shares them. */
class Tables {
  readonly installations: Map<InstallationId, Row<StoredInstallation>>;
  readonly manifests: Map<ContentId, Row<StoredManifest>>;
  readonly modules: Map<ModuleId, Row<Module>>;

  constructor(from?: Tables) {
    this.installations = new Map(from?.installations);
    this.manifests = new Map(from?.manifests);
    this.modules = new Map(from?.modules);
  }

  copy(): Tables {
    return new Tables(this);
  }

  getInstallation(id: InstallationId): StoredInstallation | null {
    return detachedRecord(this.installations.get(id));
  }

  getManifest(contentId: ContentId): StoredManifest | null {
    return detachedRecord(this.manifests.get(contentId));
  }

  getModule(id: ModuleId): Module | null {
    return detachedRecord(this.modules.get(id));
  }

  listInstallations(
    query: InstallationListQuery
  ): ModuleStorePage<StoredInstallation> {
    return page(
      this.installations,
      query,
      (stored) =>
        query.moduleId === undefined ||
        stored.installation.moduleId === query.moduleId
    );
  }

  listManifests(query: ManifestListQuery): StoredManifest[] {
    return [...this.manifests.values()]
      .filter(
        (row) =>
          query.moduleId === undefined || row.record.moduleId === query.moduleId
      )
      .map((row) => structuredClone(row.record));
  }

  listModules(query: ModuleListQuery): ModuleStorePage<Module> {
    return page(
      this.modules,
      query,
      (module) =>
        query.artifactId === undefined || module.artifactId === query.artifactId
    );
  }

  /** Applies `write`, the store's own copy, which its rows then hold. */
  apply(write: OwnedWrite): void {
    for (const id of write.deleteInstallations) {
      this.installations.delete(id);
    }
    for (const contentId of write.deleteManifests) {
      this.manifests.delete(contentId);
    }
    for (const id of write.deleteModules) {
      this.modules.delete(id);
    }
    put(
      this.modules,
      write.putModules.map((module) => [module.id, module])
    );
    put(
      this.manifests,
      write.putManifests.map((stored) => [stored.contentId, stored])
    );
    put(
      this.installations,
      write.putInstallations.map((stored) => [stored.installation.id, stored])
    );
  }
}

/**
 * Files each record under its key. A new key takes a position past every
 * one the table holds, as the SQLite store assigns them; a key put again
 * keeps its own. A Map keeps the order keys were first set, which is
 * therefore position order.
 */
function put<K, T>(
  table: Map<K, Row<T>>,
  entries: readonly (readonly [K, T])[]
): void {
  let next = 1;
  for (const row of table.values()) {
    next = Math.max(next, row.position + 1);
  }
  for (const [key, record] of entries) {
    const kept = table.get(key);
    if (kept === undefined) {
      table.set(key, { position: next, record });
      next += 1;
    } else {
      table.set(key, { position: kept.position, record });
    }
  }
}

function detachedRecord<T>(row: Row<T> | undefined): T | null {
  return row === undefined ? null : structuredClone(row.record);
}

/** The matching rows after `query.after`, at most `query.limit`, as copies. */
function page<K, T>(
  table: ReadonlyMap<K, Row<T>>,
  query: ModuleStorePageQuery,
  matches: (record: T) => boolean
): ModuleStorePage<T> {
  const after = query.after ?? 0;
  const found = [...table.values()].filter(
    (row) => row.position > after && matches(row.record)
  );
  const items = found.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items: items.map((row) => structuredClone(row.record)),
    ...(found.length > query.limit && last !== undefined
      ? { next: last.position }
      : {}),
  };
}
