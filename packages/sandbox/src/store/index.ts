/**
 * The persistence seam of the containers registry. Runtime-free so storage
 * adapters can implement it without loading a microVM provider. The records
 * it carries are defined once, in `../schema`, and imported as types only.
 */

import type { ContainerRow, SandboxEvent } from "../schema";

export type { ContainerRow, ContainerRowStatus, SandboxEvent } from "../schema";

/** One atomic write. Deletes apply before puts. */
export interface ContainerStoreWrite {
  /** Ids of rows to delete. An id with no row is not an error. */
  readonly deleteContainers?: readonly string[];
  /**
   * What the write changes, as the registry records it, in order. A store
   * keeps none of them. Every store takes them when `commit` is called, by
   * one rule (`./events`): each is copied as plain JSON, and a write holding
   * one that is not (a class instance, a property a copy would not see, a
   * Date, `undefined`, NaN) is refused whole with a `TypeError`. A store
   * with a host hook passes its copy to the hook unchanged. An event's `at`
   * is when the change was built, not when it committed: it does not order
   * commits.
   */
  readonly events?: readonly SandboxEvent[];
  /** Whole rows to keep, each replacing any row with the same id. */
  readonly putContainers?: readonly ContainerRow[];
}

/**
 * A store keeps container rows and applies one write atomically. It enforces
 * nothing: unique ids, which rows exist, and status transitions are the
 * registry's rules, checked before a write reaches the store. Values crossing
 * this seam are detached, and the rows it hands out are frozen. `list`
 * returns rows in the order first put; a row put again keeps its place.
 *
 * `@foundry/sandbox/store/memory` and `@foundry/sandbox/store/sqlite`
 * implement it; `@foundry/sandbox/testing/store` is the suite every
 * implementation passes.
 */
export interface ContainerStore {
  commit(write: ContainerStoreWrite): Promise<void>;
  get(id: string): Promise<ContainerRow | undefined>;
  list(): Promise<readonly ContainerRow[]>;
  /**
   * Runs one read-modify-write so that no other write to the store lands
   * between its reads and its commit, from any registry over the store.
   * `work` reads and commits through `view` only; if it throws, none of its
   * commits are kept. A call to the store itself from inside `work` is
   * refused at once: it could only wait for `work`. Without a transaction,
   * a registry serializes its own writes and no further.
   */
  transaction?<T>(work: (view: ContainerStore) => Promise<T>): Promise<T>;
}
