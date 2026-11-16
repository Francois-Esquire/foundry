import { ownedWrite } from "@foundry/lib/plain-json";
import { Turns } from "@foundry/lib/turns";
import type { ContainerRow } from "../schema";
import type { ContainerStore, ContainerStoreWrite } from "./index";

type Rows = Map<string, ContainerRow>;

const REENTRY =
  "The memory container store was called from inside its own transaction; use the view passed to the transaction's work instead";

export function createMemoryContainerStore(): ContainerStore {
  let rows: Rows = new Map();
  const turns = new Turns(REENTRY);

  return {
    commit: (write) =>
      withOwnCopy(write, (copy) =>
        turns.run(() => {
          rows = applied(rows, copy);
          return Promise.resolve();
        })
      ),
    get: (id) => turns.run(() => Promise.resolve(read(rows, id))),
    list: () => turns.run(() => Promise.resolve(readAll(rows))),
    transaction: (work) =>
      turns.run(async () => {
        let staged = rows;
        let open = true;
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
