import type { ContainerRow } from "../schema";
import type { ContainerStore, ContainerStoreWrite } from "./index";

type Rows = Map<string, ContainerRow>;

/**
 * The default store: a map in this process. Reads hand out frozen copies.
 * Commits and transactions take turns in one queue; a transaction works on a
 * staged copy of the rows that replaces them only when its work succeeds.
 */
export function createMemoryContainerStore(): ContainerStore {
  let rows: Rows = new Map();
  let tail: Promise<unknown> = Promise.resolve();

  const queued = <T>(work: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  return {
    commit: (write) => queued(() => apply(rows, write)),
    get: (id) => Promise.resolve(read(rows, id)),
    list: () => Promise.resolve(readAll(rows)),
    transaction: (work) =>
      queued(async () => {
        const staged: Rows = new Map(rows);
        let open = true;
        const view: ContainerStore = {
          commit(write) {
            if (!open) {
              return Promise.reject(new Error("transaction is closed"));
            }
            try {
              apply(staged, write);
            } catch (error: unknown) {
              return Promise.reject(error);
            }
            return Promise.resolve();
          },
          get: (id) => Promise.resolve(read(staged, id)),
          list: () => Promise.resolve(readAll(staged)),
        };
        try {
          const result = await work(view);
          rows = staged;
          return result;
        } finally {
          open = false;
        }
      }),
  };
}

function apply(rows: Rows, write: ContainerStoreWrite): void {
  // Copy every row first so one that cannot be read refuses the whole write.
  const puts = (write.putContainers ?? []).map(detached);
  for (const id of write.deleteContainers ?? []) {
    rows.delete(id);
  }
  for (const row of puts) {
    rows.set(row.id, row);
  }
}

function read(rows: Rows, id: string): ContainerRow | undefined {
  const row = rows.get(id);
  return row === undefined ? undefined : detached(row);
}

function readAll(rows: Rows): readonly ContainerRow[] {
  return Object.freeze([...rows.values()].map(detached));
}

function detached(row: ContainerRow): ContainerRow {
  return Object.freeze(structuredClone(row));
}
