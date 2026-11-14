import type { ContainerRow } from "../schema";
import type { ContainerStore } from "./index";

/** The default store: a map in this process. Reads hand out frozen copies. */
export function createMemoryContainerStore(): ContainerStore {
  const rows = new Map<string, ContainerRow>();
  return {
    commit(write) {
      // Clone first so a row that cannot be cloned refuses the whole write.
      let puts: ContainerRow[];
      try {
        puts = (write.putContainers ?? []).map(detached);
      } catch (error: unknown) {
        return Promise.reject(error);
      }
      for (const id of write.deleteContainers ?? []) {
        rows.delete(id);
      }
      for (const row of puts) {
        rows.set(row.id, row);
      }
      return Promise.resolve();
    },
    get(id) {
      const row = rows.get(id);
      return Promise.resolve(row === undefined ? undefined : detached(row));
    },
    list() {
      return Promise.resolve(Object.freeze([...rows.values()].map(detached)));
    },
  };
}

function detached(row: ContainerRow): ContainerRow {
  return Object.freeze(structuredClone(row));
}
