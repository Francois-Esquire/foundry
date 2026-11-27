import { createContainers } from "../../containers/containers";
import type { ContainerSpecInput } from "../../containers/spec";
import type { ContainerStore, ContainerStoreWrite } from "../../store/index";
import { MemoryContainerStore } from "../../store/memory";
import type { ContainerRow } from "../../store/schema";
import { SqliteContainerStore } from "../../store/sqlite";
import { createFakeDriver } from "../../testing/index";
import { libsqlDatabases } from "./sqlite";

export const CONTAINER_SPEC: ContainerSpecInput = {
  expose: [{ port: 3000 }],
  image: "docker.io/oven/bun:1",
};

const databases = {
  file: libsqlDatabases("file"),
  memory: libsqlDatabases("memory"),
};

function sqliteStore(location: keyof typeof databases): ContainerStore {
  const ready = databases[location]
    .open()
    .then((database) => new SqliteContainerStore({ database, scope: "s" }));
  return {
    commit: async (write) => await (await ready).commit(write),
    get: async (id) => await (await ready).get(id),
    identity: async () => await (await ready).identity(),
    list: async () => await (await ready).list(),
    async transaction(work) {
      const store = await ready;
      if (store.transaction === undefined) {
        throw new Error("the SQLite store offers a transaction");
      }
      return await store.transaction(work);
    },
  };
}

export const CONTAINER_STORES: [string, () => ContainerStore][] = [
  ["the memory store", () => new MemoryContainerStore()],
  ["the SQLite store in memory", () => sqliteStore("memory")],
  ["the SQLite store on a file", () => sqliteStore("file")],
];

let currentStore: () => ContainerStore = () => new MemoryContainerStore();

export function useStore(open: () => ContainerStore): void {
  currentStore = open;
}

export function newStore(): ContainerStore {
  return currentStore();
}

export function fixture(instanceLabel = "instance-a") {
  const runtime = createFakeDriver();
  const store = newStore();
  const containers = createContainers({
    driver: runtime,
    instanceLabel,
    store,
  });
  return { containers, runtime, store };
}

export function gatedStore({ transactional = false } = {}) {
  const inner = newStore();
  const writes: ContainerStoreWrite[] = [];
  let gate:
    | { matches: (write: ContainerStoreWrite) => boolean; open: Promise<void> }
    | undefined;
  let held = (): void => undefined;
  const gated = (target: ContainerStore): ContainerStore => ({
    async commit(write) {
      writes.push(write);
      const current = gate;
      if (current?.matches(write)) {
        gate = undefined;
        held();
        await current.open;
      }
      await target.commit(write);
    },
    get: async (id) => await target.get(id),
    identity: async () => await target.identity(),
    list: async () => await target.list(),
  });
  const store: ContainerStore = transactional
    ? {
        ...gated(inner),
        transaction<T>(work: (view: ContainerStore) => Promise<T>) {
          if (inner.transaction === undefined) {
            throw new Error("the store under test offers a transaction");
          }
          return inner.transaction((view) => work(gated(view)));
        },
      }
    : gated(inner);
  return {
    hold(matches: (write: ContainerStoreWrite) => boolean) {
      let release = (): void => undefined;
      const open = new Promise<void>((resolve) => {
        release = resolve;
      });
      const caught = new Promise<void>((resolve) => {
        held = resolve;
      });
      gate = { matches, open };
      return { caught, release };
    },
    store,
    writes,
  };
}

export function puts(
  writes: readonly ContainerStoreWrite[]
): Partial<ContainerRow>[] {
  return writes.flatMap((write) =>
    (write.putContainers ?? []).map(({ nativeId, status }) => ({
      nativeId,
      status,
    }))
  );
}

export function events(
  writes: readonly ContainerStoreWrite[]
): [string, string][] {
  return writes.flatMap((write) =>
    (write.events ?? []).map((event): [string, string] => [
      event.type,
      event.containerId,
    ])
  );
}
