import { describe, expect, it } from "vitest";
import type { ContainerSandboxConstraints } from "../container/constraints";
import { createContainers } from "../container/containers";
import type { ContainerStore, ContainerStoreWrite } from "../store/index";
import { MemoryContainerStore } from "../store/memory";
import { SqliteContainerStore } from "../store/sqlite";
import type { FakeContainerRuntime } from "../testing/index";
import { createFakeContainerRuntime } from "../testing/index";
import { libsqlDatabases } from "./helpers/sqlite";

const SPEC: ContainerSandboxConstraints = {
  format: "foundry.sandbox.container/1",
  image: "docker.io/oven/bun:1",
};
const REFUSED = /commit refused/;
const BUSY = /SQLITE_BUSY/;
const UNREMOVABLE = /could not remove/;

const files = libsqlDatabases("file");
const memory = libsqlDatabases("memory");

const STORES: [string, () => Promise<ContainerStore>][] = [
  ["memory", () => Promise.resolve(new MemoryContainerStore())],
  [
    "SQLite",
    async () =>
      new SqliteContainerStore({ database: await memory.open(), scope: "s" }),
  ],
];

function refusingStore(inner: ContainerStore = new MemoryContainerStore()) {
  let refusing: ((write: ContainerStoreWrite) => boolean) | undefined;
  const refused = (target: ContainerStore): ContainerStore => ({
    commit(write) {
      return refusing?.(write) === true
        ? Promise.reject(new Error("commit refused"))
        : target.commit(write);
    },
    get: (id) => target.get(id),
    identity: () => target.identity(),
    list: () => target.list(),
  });
  const store: ContainerStore = {
    ...refused(inner),
    transaction(work) {
      if (inner.transaction === undefined) {
        throw new Error("the memory store offers a transaction");
      }
      return inner.transaction((view) => work(refused(view)));
    },
  };
  return {
    allow() {
      refusing = undefined;
    },
    refuse(matches: (write: ContainerStoreWrite) => boolean) {
      refusing = matches;
    },
    store,
  };
}

function recordsRunning(write: ContainerStoreWrite): boolean {
  return (write.putContainers ?? []).some((row) => row.status === "running");
}

function stubbornRuntime(count: number): FakeContainerRuntime {
  const runtime = createFakeContainerRuntime();
  const create = runtime.create.bind(runtime);
  let left = count;
  runtime.create = async (spec) => {
    const instance = await create(spec);
    if (left > 0) {
      left -= 1;
      instance.remove = () => Promise.reject(new Error("remove failed"));
    }
    return instance;
  };
  return runtime;
}

function brokenSetupRuntime(cleanupFails: boolean): FakeContainerRuntime {
  const runtime = createFakeContainerRuntime();
  const create = runtime.create.bind(runtime);
  runtime.create = async (spec) => {
    const instance = await create(spec);
    instance.ensureDirectory = () =>
      Promise.reject(new Error("guest setup failed"));
    if (cleanupFails) {
      instance.remove = () => Promise.reject(new Error("remove failed"));
    }
    return instance;
  };
  return runtime;
}

function remaining(runtime: FakeContainerRuntime): string[] {
  return runtime.instances
    .filter((instance) => !instance.removed)
    .map((instance) => instance.id);
}

describe("a commit that fails after a boot", () => {
  it("start removes the VM it booted and rejects with the commit's error", async () => {
    const { allow, refuse, store } = refusingStore();
    const runtime = createFakeContainerRuntime();
    const containers = createContainers({ instanceLabel: "a", runtime, store });
    refuse(recordsRunning);

    await expect(containers.start(SPEC)).rejects.toThrow(REFUSED);

    expect(runtime.instances).toHaveLength(1);
    expect(remaining(runtime)).toEqual([]);
    const [row] = await store.list();
    expect(row).toMatchObject({ nativeId: `${row?.id}-1`, status: "failed" });
    allow();
    expect((await containers.sweep()).swept).toEqual([]);
    await containers.shutdown();
    expect(remaining(runtime)).toEqual([]);
  });

  it("open removes the VM it booted, and the next open boots anew", async () => {
    const { allow, refuse, store } = refusingStore();
    const runtime = createFakeContainerRuntime();
    const containers = createContainers({ instanceLabel: "a", runtime, store });
    const first = await containers.start(SPEC);
    await first.close();
    refuse(recordsRunning);

    await expect(containers.open(first.id)).rejects.toThrow(REFUSED);

    expect(runtime.instances.map((instance) => instance.id)).toEqual([
      `${first.id}-1`,
      `${first.id}-2`,
    ]);
    expect(remaining(runtime)).toEqual([]);
    expect(await store.get(first.id)).toMatchObject({
      nativeId: `${first.id}-2`,
      status: "failed",
    });
    allow();
    const again = await containers.open(first.id);
    expect(remaining(runtime)).toEqual([`${first.id}-3`]);
    await again.close();
    expect((await containers.sweep()).swept).toEqual([]);
    await containers.shutdown();
    expect(remaining(runtime)).toEqual([]);
  });

  it("restart removes the VM it booted, leaving the closed handle nothing to stop", async () => {
    const { allow, refuse, store } = refusingStore();
    const runtime = createFakeContainerRuntime();
    const containers = createContainers({ instanceLabel: "a", runtime, store });
    const handle = await containers.start(SPEC);
    refuse(recordsRunning);

    await expect(containers.restart(handle.id)).rejects.toThrow(REFUSED);

    expect(runtime.instances.map((instance) => instance.id)).toEqual([
      `${handle.id}-1`,
      `${handle.id}-2`,
    ]);
    expect(remaining(runtime)).toEqual([]);
    expect(await store.get(handle.id)).toMatchObject({
      nativeId: `${handle.id}-2`,
      status: "failed",
    });
    allow();
    await handle.close();
    expect((await containers.sweep()).swept).toEqual([]);
    await containers.shutdown();
    expect(remaining(runtime)).toEqual([]);
  });

  it("start on SQLite, with another connection holding the database's lock", async () => {
    const database = await files.open();
    const store = new SqliteContainerStore({ database, scope: "s" });
    const other = files.connect(database);
    const runtime = createFakeContainerRuntime();
    const create = runtime.create.bind(runtime);
    const locked = Promise.withResolvers<void>();
    const unlock = Promise.withResolvers<void>();
    let holder: Promise<void> | undefined;
    runtime.create = (spec) => {
      holder = other.transaction(async () => {
        locked.resolve();
        await unlock.promise;
      });
      return locked.promise.then(() => create(spec));
    };
    const containers = createContainers({ instanceLabel: "a", runtime, store });

    await expect(containers.start(SPEC)).rejects.toThrow(BUSY);

    expect(runtime.instances).toHaveLength(1);
    expect(remaining(runtime)).toEqual([]);
    unlock.resolve();
    await holder;
    const [row] = await store.list();
    expect(row).toMatchObject({ nativeId: `${row?.id}-1`, status: "starting" });
    expect((await containers.sweep()).swept).toEqual([]);
    await containers.shutdown();
    expect(remaining(runtime)).toEqual([]);
  });
});

describe("a VM the Containers could not remove", () => {
  it("is removed by a later sweep", async () => {
    const { allow, refuse, store } = refusingStore();
    const runtime = stubbornRuntime(1);
    const containers = createContainers({ instanceLabel: "a", runtime, store });
    refuse(recordsRunning);

    await expect(containers.start(SPEC)).rejects.toThrow(REFUSED);
    const [row] = await store.list();
    const name = `${row?.id}-1`;
    expect(remaining(runtime)).toEqual([name]);

    allow();
    expect((await containers.sweep()).swept).toEqual([name]);
    expect(remaining(runtime)).toEqual([]);
    expect((await containers.sweep()).swept).toEqual([]);
    await containers.shutdown();
  });

  it("is removed by shutdown, which rejects while it will not go and retries when called again", async () => {
    const { refuse, store } = refusingStore();
    const failRemove: string[] = [];
    const base = createFakeContainerRuntime({ inventory: { failRemove } });
    const create = base.create.bind(base);
    base.create = async (spec) => {
      const instance = await create(spec);
      instance.remove = () => Promise.reject(new Error("remove failed"));
      return instance;
    };
    const containers = createContainers({
      instanceLabel: "a",
      runtime: base,
      store,
    });
    refuse(recordsRunning);
    await expect(containers.start(SPEC)).rejects.toThrow(REFUSED);
    const [row] = await store.list();
    const name = `${row?.id}-1`;
    failRemove.push(name);

    await expect(containers.shutdown()).rejects.toThrow(UNREMOVABLE);
    expect(remaining(base)).toEqual([name]);

    failRemove.length = 0;
    await containers.shutdown();
    expect(remaining(base)).toEqual([]);
  });

  it("is kept when the last close cannot remove it, and shutdown removes it", async () => {
    const runtime = stubbornRuntime(1);
    const store = new MemoryContainerStore();
    const containers = createContainers({ instanceLabel: "a", runtime, store });
    const handle = await containers.start(SPEC);

    await expect(handle.close()).rejects.toThrow("remove failed");
    expect(remaining(runtime)).toEqual([`${handle.id}-1`]);

    await containers.shutdown();
    expect(remaining(runtime)).toEqual([]);
  });
});

describe.each(STORES)(
  "a VM abandoned while sweep reads the inventory (%s)",
  (_name, open) => {
    it("is kept for the next sweep or shutdown, not forgotten", async () => {
      const { allow, refuse, store } = refusingStore(await open());
      const runtime = stubbornRuntime(1);
      const list = runtime.listResources.bind(runtime);
      const read = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let gated = true;
      runtime.listResources = async (query) => {
        const page = await list(query);
        if (gated) {
          gated = false;
          read.resolve();
          await resume.promise;
        }
        return page;
      };
      const containers = createContainers({
        instanceLabel: "a",
        runtime,
        store,
      });

      const sweeping = containers.sweep();
      await read.promise;
      refuse(recordsRunning);
      await expect(containers.start(SPEC)).rejects.toThrow(REFUSED);
      const [name] = remaining(runtime);
      expect(name).toBeDefined();
      resume.resolve();

      expect((await sweeping).swept).toEqual([]);
      expect(remaining(runtime)).toEqual([name]);
      allow();
      await containers.shutdown();
      expect(remaining(runtime)).toEqual([]);
    });
  }
);

describe("an old VM whose stop fails", () => {
  async function reopened() {
    const failStop: string[] = [];
    const runtime = createFakeContainerRuntime({ inventory: { failStop } });
    const store = new MemoryContainerStore();
    const before = createContainers({ instanceLabel: "a", runtime, store });
    const { id } = await before.start(SPEC);
    const containers = createContainers({ instanceLabel: "a", runtime, store });
    return { containers, failStop, id, runtime, store };
  }

  it("is kept by open, and sweep removes it, leaving the new VM live", async () => {
    const { containers, failStop, id, runtime } = await reopened();
    failStop.push(`${id}-1`);

    const handle = await containers.open(id);
    expect(remaining(runtime)).toEqual([`${id}-1`, `${id}-2`]);

    failStop.length = 0;
    expect((await containers.sweep()).swept).toEqual([`${id}-1`]);
    expect(remaining(runtime)).toEqual([`${id}-2`]);
    await expect(handle.commands.exec(["true"])).resolves.toBeDefined();
    await containers.shutdown();
    expect(remaining(runtime)).toEqual([]);
  });

  it("is kept by open while it will not stop, and shutdown removes it once it does", async () => {
    const { containers, failStop, id, runtime } = await reopened();
    failStop.push(`${id}-1`);
    await containers.open(id);

    await expect(containers.shutdown()).rejects.toThrow(UNREMOVABLE);
    expect(remaining(runtime)).toEqual([`${id}-1`]);
    failStop.length = 0;
    await containers.shutdown();
    expect(remaining(runtime)).toEqual([]);
  });

  it("is kept by remove with its row, removing, until a later recovery confirms it gone", async () => {
    const { containers, failStop, id, runtime, store } = await reopened();
    failStop.push(`${id}-1`);

    await expect(containers.remove(id)).rejects.toThrow("kept to retry");
    expect(await store.get(id)).toMatchObject({ status: "removing" });
    expect(remaining(runtime)).toEqual([`${id}-1`]);
    failStop.length = 0;
    await containers.shutdown();
    const next = createContainers({ instanceLabel: "a", runtime, store });
    expect(await next.recover(() => true)).toEqual({
      conflicts: [],
      kept: [],
      passedOver: [],
      removed: [id],
      swept: [],
    });
    expect(await store.get(id)).toBeUndefined();
    expect(remaining(runtime)).toEqual([]);
    await next.shutdown();
  });
});

describe("a boot whose guest setup fails", () => {
  it("rejects with the setup's error and keeps a VM it could not remove for sweep", async () => {
    const runtime = brokenSetupRuntime(true);
    const store = new MemoryContainerStore();
    const containers = createContainers({ instanceLabel: "a", runtime, store });

    await expect(containers.start(SPEC)).rejects.toThrow("guest setup failed");
    const [row] = await store.list();
    expect(row?.status).toBe("failed");
    expect(remaining(runtime)).toEqual([`${row?.id}-1`]);

    expect((await containers.sweep()).swept).toEqual([`${row?.id}-1`]);
    expect(remaining(runtime)).toEqual([]);
    await containers.shutdown();
  });

  it("keeps a VM it could not remove for shutdown", async () => {
    const runtime = brokenSetupRuntime(true);
    const containers = createContainers({
      instanceLabel: "a",
      runtime,
      store: new MemoryContainerStore(),
    });

    await expect(containers.start(SPEC)).rejects.toThrow("guest setup failed");
    expect(remaining(runtime)).toHaveLength(1);
    await containers.shutdown();
    expect(remaining(runtime)).toEqual([]);
  });

  it("keeps nothing when the removal works, so shutdown reads no inventory", async () => {
    const runtime = brokenSetupRuntime(false);
    runtime.listResources = () => Promise.reject(new Error("inventory read"));
    const containers = createContainers({
      instanceLabel: "a",
      runtime,
      store: new MemoryContainerStore(),
    });

    await expect(containers.start(SPEC)).rejects.toThrow("guest setup failed");
    expect(remaining(runtime)).toEqual([]);
    await containers.shutdown();
  });
});

describe("a boot that fails before any VM exists", () => {
  it("keeps nothing, so shutdown succeeds without reading the inventory", async () => {
    const runtime = createFakeContainerRuntime();
    runtime.create = () => Promise.reject(new Error("no hypervisor"));
    runtime.listResources = () => Promise.reject(new Error("inventory read"));
    const store = new MemoryContainerStore();
    const containers = createContainers({ instanceLabel: "a", runtime, store });

    await expect(containers.start(SPEC)).rejects.toThrow("no hypervisor");
    expect((await store.list())[0]?.status).toBe("failed");
    await containers.shutdown();
  });
});
