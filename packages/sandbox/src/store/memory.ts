import type { ContainerRow } from "../schema";
import type { ContainerStore, ContainerStoreWrite } from "./index";

type Rows = Map<string, ContainerRow>;

/**
 * The default store: a map in this process. Reads hand out frozen copies.
 * Each commit builds new rows and swaps them in only when it succeeds.
 * Commits and transactions take turns in one queue; a transaction's commits
 * build on its own staged rows, which replace the store's only when its work
 * succeeds.
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
    commit: (write) =>
      queued(() => {
        rows = applied(rows, write);
      }),
    get: (id) => Promise.resolve(read(rows, id)),
    list: () => Promise.resolve(readAll(rows)),
    transaction: (work) =>
      queued(async () => {
        let staged = rows;
        let open = true;
        const view: ContainerStore = {
          commit(write) {
            if (!open) {
              return Promise.reject(new Error("transaction is closed"));
            }
            try {
              staged = applied(staged, write);
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

/**
 * The rows after `write`, deletes before puts, built on a copy so that a
 * write failing at any point leaves `rows` exactly as they were.
 */
function applied(rows: Rows, write: ContainerStoreWrite): Rows {
  const next = new Map(rows);
  for (const id of write.deleteContainers ?? []) {
    next.delete(id);
  }
  for (const row of write.putContainers ?? []) {
    const kept = detached(row);
    next.set(kept.id, kept);
  }
  return next;
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
