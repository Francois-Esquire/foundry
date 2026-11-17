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

const REENTRY =
  "MemoryModuleStore was called from inside its own transaction; use the view passed to the transaction's work instead";

const ENDED =
  "MemoryModuleStore transaction view was used after its transaction settled";

export class MemoryModuleStore implements ModuleStore {
  readonly durability: ModuleStoreDurability = "commit";
  #tables = new Tables();
  readonly #turns = new Turns(REENTRY);

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

class MemoryView implements ModuleStore {
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

interface Row<T> {
  readonly position: number;
  readonly record: T;
}

interface OwnedWrite {
  readonly deleteInstallations: readonly InstallationId[];
  readonly deleteManifests: readonly ContentId[];
  readonly deleteModules: readonly ModuleId[];
  readonly putInstallations: readonly StoredInstallation[];
  readonly putManifests: readonly StoredManifest[];
  readonly putModules: readonly Module[];
}

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
