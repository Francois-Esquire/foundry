import { ownedWrite } from "@foundry/lib/plain-json";
import { Turns } from "@foundry/lib/turns";
import type { ContainerStore, ContainerStoreWrite } from "./index";
import type { ContainerRow } from "./schema";

type Rows = Map<string, ContainerRow>;

const REENTRY =
  "The memory container store was called from inside its own transaction; use the view passed to the transaction's work instead";

export class MemoryContainerStore implements ContainerStore {
  #rows: Rows = new Map();
  readonly #turns = new Turns(REENTRY);
  readonly #identity = globalThis.crypto.randomUUID();

  commit(write: ContainerStoreWrite): Promise<void> {
    return withOwnCopy(write, (copy) =>
      this.#turns.run(() => {
        this.#rows = applied(this.#rows, copy);
        return Promise.resolve();
      })
    );
  }

  get(id: string): Promise<ContainerRow | undefined> {
    return this.#turns.run(() => Promise.resolve(read(this.#rows, id)));
  }

  identity(): Promise<string> {
    return Promise.resolve(this.#identity);
  }

  list(): Promise<readonly ContainerRow[]> {
    return this.#turns.run(() => Promise.resolve(readAll(this.#rows)));
  }

  transaction<T>(work: (view: ContainerStore) => Promise<T>): Promise<T> {
    return this.#turns.run(async () => {
      let staged = this.#rows;
      let open = true;
      const identity = this.#identity;
      const view: ContainerStore = {
        commit(write) {
          if (!open) {
            return Promise.reject(new Error("transaction is closed"));
          }
          return withOwnCopy(write, (copy) => {
            staged = applied(staged, copy);
            return Promise.resolve();
          });
        },
        get: (id) => Promise.resolve(read(staged, id)),
        identity: () => Promise.resolve(identity),
        list: () => Promise.resolve(readAll(staged)),
      };
      try {
        const result = await work(view);
        this.#rows = staged;
        return result;
      } finally {
        open = false;
      }
    });
  }
}

function withOwnCopy(
  write: ContainerStoreWrite,
  take: (copy: ContainerStoreWrite) => Promise<void>
): Promise<void> {
  let copy: ContainerStoreWrite;
  try {
    copy = ownedWrite(write);
  } catch (error: unknown) {
    return Promise.reject(error);
  }
  return take(copy);
}

function applied(rows: Rows, write: ContainerStoreWrite): Rows {
  const next = new Map(rows);
  for (const id of write.deleteContainers ?? []) {
    next.delete(id);
  }
  for (const row of write.putContainers ?? []) {
    next.set(row.id, Object.freeze(row));
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
