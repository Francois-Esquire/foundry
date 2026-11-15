import type { ContentId } from "@foundry/artifacts";
import { Turns } from "@foundry/lib/turns";

import type { InstallationId, ModuleId } from "../domain";
import type {
  InstallationListQuery,
  ManifestListQuery,
  Module,
  ModuleListQuery,
  ModuleStore,
  ModuleStoreDurability,
  ModuleStorePage,
  ModuleStorePageQuery,
  ModuleStoreWrite,
  StoredInstallation,
  StoredManifest,
} from "../store";
import { capturedQuery, capturedWrite } from "./captured";
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
 * Every commit, the store's own and a view's alike, applies its write to a
 * copy of the tables and swaps the copy in only once the whole write has
 * applied, so no failure of any kind leaves part of a write. A transaction
 * keeps its view's tables only if its work succeeds. Copying the tables
 * copies their maps, not the records, which are never changed in place.
 */
export class MemoryModuleStore implements ModuleStore {
  readonly durability: ModuleStoreDurability = "commit";
  #tables = new Tables();
  readonly #turns = new Turns(REENTRY);

  /**
   * Takes the write as it stands now: a capture of each property it names
   * (`./captured`), copied with `structuredClone`, made before the commit
   * waits its turn, so a caller changing the write later changes nothing. A
   * write the capture or the copy refuses rejects whole and changes nothing.
   * A transaction's view commits the same way.
   */
  commit(write: ModuleStoreWrite): Promise<void> {
    let owned: OwnedWrite;
    try {
      owned = ownedWrite(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() => {
      this.#tables = this.#tables.applied(owned);
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
      owned = capturedQuery(query);
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
      owned = ownedQuery(capturedQuery(query));
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#read((tables) => read(tables, owned));
  }
}

/**
 * A transaction's view: reads see the store's tables until the first
 * commit; each commit applies to a copy, which the view then reads.
 */
class MemoryView implements ModuleStore {
  /** Its commits stand only if the transaction's work succeeds. */
  readonly durability: ModuleStoreDurability = "host";
  tables: Tables;
  #ended: boolean;

  constructor(tables: Tables) {
    this.tables = tables;
    this.#ended = false;
  }

  end(): void {
    this.#ended = true;
  }

  /** Takes its copy of `write` at once, as the store does. */
  commit(write: ModuleStoreWrite): Promise<void> {
    let owned: OwnedWrite;
    try {
      owned = ownedWrite(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#run(() => {
      this.tables = this.tables.applied(owned);
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
    return this.#run(() =>
      this.tables.listInstallations(ownedQuery(capturedQuery(query)))
    );
  }

  listManifests(
    query: ManifestListQuery = {}
  ): Promise<readonly StoredManifest[]> {
    return this.#run(() => this.tables.listManifests(capturedQuery(query)));
  }

  listModules(query: ModuleListQuery): Promise<ModuleStorePage<Module>> {
    return this.#run(() =>
      this.tables.listModules(ownedQuery(capturedQuery(query)))
    );
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

/** A write's records, captured and copied so they share nothing with the caller's. */
interface OwnedWrite {
  readonly deleteInstallations: readonly InstallationId[];
  readonly deleteManifests: readonly ContentId[];
  readonly deleteModules: readonly ModuleId[];
  readonly putInstallations: readonly StoredInstallation[];
  readonly putManifests: readonly StoredManifest[];
  readonly putModules: readonly Module[];
}

/** The store's own copy of `write`: its capture, deeply copied. */
function ownedWrite(write: ModuleStoreWrite): OwnedWrite {
  const copy = structuredClone(capturedWrite(write));
  return {
    deleteInstallations: copy.deleteInstallations ?? [],
    deleteManifests: copy.deleteManifests ?? [],
    deleteModules: copy.deleteModules ?? [],
    putInstallations: copy.putInstallations ?? [],
    putManifests: copy.putManifests ?? [],
    putModules: copy.putModules ?? [],
  };
}

/**
 * The store's records, and `next`, the position its next new record of any
 * table takes. `next` only grows, so a position is never handed out twice
 * and a cursor stays valid across deletes. Rows are never changed in place,
 * so a copy shares them.
 */
class Tables {
  readonly installations: Map<InstallationId, Row<StoredInstallation>>;
  readonly manifests: Map<ContentId, Row<StoredManifest>>;
  readonly modules: Map<ModuleId, Row<Module>>;
  #next: number;

  constructor(from?: Tables) {
    this.installations = new Map(from?.installations);
    this.manifests = new Map(from?.manifests);
    this.modules = new Map(from?.modules);
    this.#next = from === undefined ? 1 : from.#next;
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

  /**
   * These tables with `write`, the store's own copy, applied: deletes, then
   * puts. A new table; this one is left as it was, whatever fails.
   */
  applied(write: OwnedWrite): Tables {
    const next = new Tables(this);
    for (const id of write.deleteInstallations) {
      next.installations.delete(id);
    }
    for (const contentId of write.deleteManifests) {
      next.manifests.delete(contentId);
    }
    for (const id of write.deleteModules) {
      next.modules.delete(id);
    }
    for (const module of write.putModules) {
      next.#put(next.modules, module.id, module);
    }
    for (const stored of write.putManifests) {
      next.#put(next.manifests, stored.contentId, stored);
    }
    for (const stored of write.putInstallations) {
      next.#put(next.installations, stored.installation.id, stored);
    }
    return next;
  }

  /**
   * Files `record` under `key`. A new key takes the next position; a key put
   * again keeps its own. A Map keeps the order keys were first set, which is
   * therefore position order.
   */
  #put<K, T>(table: Map<K, Row<T>>, key: K, record: T): void {
    const kept = table.get(key);
    if (kept === undefined) {
      table.set(key, { position: this.#next, record });
      this.#next += 1;
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
