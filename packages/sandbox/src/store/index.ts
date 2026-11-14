/**
 * The persistence seam of the containers registry. Runtime-free so storage
 * adapters can implement it without loading a microVM provider. The records
 * it carries are defined once, in `../schema`, and imported as types only.
 */

import type { ContainerRow } from "../schema";

export type { ContainerRow, ContainerRowStatus } from "../schema";

/** One atomic write. Deletes apply before puts. */
export interface ContainerStoreWrite {
  /** Ids of rows to delete. An id with no row is not an error. */
  readonly deleteContainers?: readonly string[];
  /** Whole rows to keep, each replacing any row with the same id. */
  readonly putContainers?: readonly ContainerRow[];
}

/**
 * A store keeps container rows and applies one write atomically. It enforces
 * nothing: unique ids, which rows exist, and status transitions are the
 * registry's rules, checked before a write reaches the store. Values crossing
 * this seam are detached.
 */
export interface ContainerStore {
  commit(write: ContainerStoreWrite): Promise<void>;
  get(id: string): Promise<ContainerRow | undefined>;
  list(): Promise<readonly ContainerRow[]>;
}
