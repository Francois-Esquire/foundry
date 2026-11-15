import type { ArtifactId, ContentId } from "@foundry/artifacts";

import type { InstallationId, ModuleId } from "./domain";
import type { Module, StoredInstallation, StoredManifest } from "./schema";

export type { Module, StoredInstallation, StoredManifest } from "./schema";

/**
 * One atomic write. Deletes apply before puts. A key is left out, never set
 * to `undefined`.
 *
 * A put files a record under its key, or replaces the record filed there: a
 * Module by its id, a retained manifest by its Content id, and an
 * Installation, with its whole set of Grants, by its id. A replaced record
 * keeps its place in list order; a new one goes last.
 */
export interface ModuleStoreWrite {
  readonly deleteInstallations?: readonly InstallationId[];
  /** Content ids of retained manifests. */
  readonly deleteManifests?: readonly ContentId[];
  readonly deleteModules?: readonly ModuleId[];
  readonly putInstallations?: readonly StoredInstallation[];
  readonly putManifests?: readonly StoredManifest[];
  readonly putModules?: readonly Module[];
}

/**
 * When a commit that resolved is there for good. `"commit"`: at once. `"host"`:
 * only once a transaction the store does not own commits, so a rollback
 * there can still remove it; a transaction's view is `"host"`, and so is a
 * SQLite store over a transaction the host began. Anything that acts on a
 * committed change outside the store (cancelling Invocations, say) refuses
 * a `"host"` store.
 */
export type ModuleStoreDurability = "commit" | "host";

/**
 * Where a list read stops and the next page starts. Opaque: pass back the
 * `next` a page returned, and nothing else.
 */
export type ModuleStoreCursor = number;

/** Which page of a list read to return. */
export interface ModuleStorePageQuery {
  /** Only records after this cursor; from the first record when absent. */
  readonly after?: ModuleStoreCursor;
  /** At most this many records: a positive safe integer. */
  readonly limit: number;
}

/** One page of a list read, in the order the records were first put. */
export interface ModuleStorePage<T> {
  readonly items: readonly T[];
  /** Present when a further record matches; pass it as `after` to read on. */
  readonly next?: ModuleStoreCursor;
}

export interface ModuleListQuery extends ModuleStorePageQuery {
  /** Only the Modules on this Artifact; every Module when absent. */
  readonly artifactId?: ArtifactId;
}

export interface InstallationListQuery extends ModuleStorePageQuery {
  /** Only this Module's Installations; every Installation when absent. */
  readonly moduleId?: ModuleId;
}

export interface ManifestListQuery {
  /** Only the manifests this Module retains; every one when absent. */
  readonly moduleId?: ModuleId;
}

/**
 * The persistence seam. A store keeps Modules, retained manifests, and
 * Installations with their Grants, and applies one write atomically. It
 * enforces nothing: unique ids, one Module per Artifact, generations,
 * status transitions, Grant sets and which Module owns a manifest are the
 * rules of `ModuleRegistry` (`@foundry/modules/registry`), checked before a
 * write reaches the store. Values crossing this seam are detached: a store
 * takes its own copy of a write when `commit` is called, and a caller
 * changing the write afterwards changes nothing it keeps.
 *
 * A store takes a write by reading each property the interface names once,
 * by name, when `commit` is called (`./store/captured`), and refuses a
 * record that is not plain data. A commit lands whole or not at all.
 *
 * List reads return records in the order they were first put, filtered by
 * exact values and paged by cursor. A record's position is never handed
 * out again in its scope, so a cursor stays valid across deletes. Sorting
 * by id stays with the registry.
 *
 * `@foundry/modules/store/memory` and `@foundry/modules/store/sqlite`
 * implement it; `@foundry/modules/testing/store` is the suite every
 * implementation passes.
 */
export interface ModuleStore {
  commit(write: ModuleStoreWrite): Promise<void>;
  /**
   * When a commit that resolved is there for good; `"commit"` when absent.
   * A transaction's view is `"host"`: its commits stand only if the work
   * succeeds.
   */
  readonly durability?: ModuleStoreDurability;
  getInstallation(id: InstallationId): Promise<StoredInstallation | null>;
  /** The manifest retained for a Content. */
  getManifest(contentId: ContentId): Promise<StoredManifest | null>;
  getModule(id: ModuleId): Promise<Module | null>;
  listInstallations(
    query: InstallationListQuery
  ): Promise<ModuleStorePage<StoredInstallation>>;
  /** Every matching retained manifest: a library retains a handful. */
  listManifests(query?: ManifestListQuery): Promise<readonly StoredManifest[]>;
  listModules(query: ModuleListQuery): Promise<ModuleStorePage<Module>>;
  /**
   * Runs one read-modify-write, or one read of several steps, so that no
   * other write lands between its reads and its commit, from any registry
   * over the store: a plain `commit` waits until `work` settles. `work`
   * reads and commits through `view` only, and its reads see its own
   * commits: a call to the store itself from inside `work` rejects at once
   * with an error saying to use the view. If `work` throws, none of its
   * commits stay. Without it, changes are serialized per registry and no
   * further.
   */
  transaction?<T>(work: (view: ModuleStore) => Promise<T>): Promise<T>;
}
