/**
 * Persistence contract for the containers registry. Runtime-free so storage
 * adapters can implement it without loading a microVM provider. The records
 * it carries are defined once, in `../schema`, and imported as types only.
 */

import type { ContainerRow, ContainerRowPatch } from "../schema";

export type {
  ContainerRow,
  ContainerRowPatch,
  ContainerRowStatus,
} from "../schema";

export interface ContainerStore {
  get(id: string): Promise<ContainerRow | undefined>;
  insert(row: ContainerRow): Promise<void>;
  list(): Promise<readonly ContainerRow[]>;
  remove(id: string): Promise<void>;
  update(id: string, patch: ContainerRowPatch): Promise<void>;
}

export function createMemoryContainerStore(): ContainerStore {
  const rows = new Map<string, ContainerRow>();
  return {
    get(id) {
      return Promise.resolve(rows.get(id));
    },
    insert(row) {
      if (rows.has(row.id)) {
        return Promise.reject(new Error(`container ${row.id} already exists`));
      }
      rows.set(row.id, Object.freeze({ ...row }));
      return Promise.resolve();
    },
    list() {
      return Promise.resolve(Object.freeze([...rows.values()]));
    },
    remove(id) {
      rows.delete(id);
      return Promise.resolve();
    },
    update(id, patch: ContainerRowPatch) {
      const current = rows.get(id);
      if (current === undefined) {
        return Promise.reject(new Error(`container ${id} does not exist`));
      }
      rows.set(id, Object.freeze({ ...current, ...patch }));
      return Promise.resolve();
    },
  };
}
