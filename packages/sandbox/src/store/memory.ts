import { Turns } from "@foundry/lib/turns";

import type { ContainerRow } from "../schema";
import type { ContainerStore, ContainerStoreWrite } from "./index";

type Rows = Map<string, ContainerRow>;

/** Why a call from inside the store's own transaction is refused. */
const REENTRY =
  "The memory container store was called from inside its own transaction; use the view passed to the transaction's work instead";

/**
 * The default store: a map in this process. Reads hand out frozen copies and
 * list rows in the order they were first put; a put over a kept row keeps
 * its place. Each commit builds new rows and swaps them in only when it
 * succeeds.
 *
 * A commit takes the write as it stands when it is called: one
 * `structuredClone` of it, made before the commit waits its turn, so a
 * caller changing the write later changes nothing; a transaction's view
 * takes its writes the same way. A write the clone refuses rejects whole.
 *
 * Every call takes a turn, so a commit made while a transaction runs lands
 * after it, and a call made from inside a transaction's work is refused: it
 * could only wait for itself. A transaction's commits build on its own
 * staged rows, which replace the store's only when its work succeeds.
 */
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

/**
 * `take` with the store's own copy of `write`, or a rejection when the
 * write cannot be cloned.
 */
function withOwnCopy(
  write: ContainerStoreWrite,
  take: (copy: ContainerStoreWrite) => Promise<void>
): Promise<void> {
  let copy: ContainerStoreWrite;
  try {
    copy = structuredClone(write);
  } catch (error: unknown) {
    return Promise.reject(error);
  }
  return take(copy);
}

/**
 * The rows after `write`, the store's own copy, deletes before puts, built
 * on a new map so that `rows` stay exactly as they were.
 */
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
