import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerSandboxConstraints } from "../container/constraints";
import {
  CONTAINER_ENVIRONMENT_ID_LABEL,
  CONTAINER_ID_LABEL,
  CONTAINER_INSTANCE_LABEL,
  CONTAINER_MANAGED_BY_LABEL,
  CONTAINER_MANAGED_BY_VALUE,
  CONTAINER_RUNTIME_SCOPE_LABEL,
  CONTAINER_STORE_LABEL,
} from "../container/defaults";
import {
  provisionContainerSandbox,
  startContainerSandbox,
} from "../node/container-sandbox";
import { createContainers } from "../node/containers";
import type { ContainerStore, ContainerStoreWrite } from "../store/index";
import { MemoryContainerStore } from "../store/memory";
import { SqliteContainerStore } from "../store/sqlite";
import type { FakeContainerRuntime } from "../testing/fake-container-runtime";
import { createFakeContainerRuntime } from "../testing/fake-container-runtime";
import {
  CONTAINER_SPEC,
  CONTAINER_STORES,
  fixture,
  newStore,
  useStore,
} from "./helpers/containers-fixture";
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
    expect(await containers.sweep()).toEqual([]);
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
    expect(await containers.sweep()).toEqual([]);
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
    expect(await containers.sweep()).toEqual([]);
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
    expect(await containers.sweep()).toEqual([]);
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
    expect(await containers.sweep()).toEqual([name]);
    expect(remaining(runtime)).toEqual([]);
    expect(await containers.sweep()).toEqual([]);
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

      expect(await sweeping).toEqual([]);
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
    expect(await containers.sweep()).toEqual([`${id}-1`]);
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

    expect(await containers.sweep()).toEqual([`${row?.id}-1`]);
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

describe("a start whose guest setup and removal both fail", () => {
  it("rejects with the setup's error even when the left-behind callback throws", async () => {
    const runtime = brokenSetupRuntime(true);
    const provisioned = await provisionContainerSandbox({}, { runtime });
    const onLeftBehind = vi.fn(() => {
      throw new Error("callback failed");
    });

    await expect(
      startContainerSandbox(provisioned, { onLeftBehind })
    ).rejects.toThrow("guest setup failed");
    expect(onLeftBehind).toHaveBeenCalledWith(
      expect.objectContaining({ message: "remove failed" })
    );
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

describe.each(CONTAINER_STORES)(
  "container ownership over %s",
  (_name, open) => {
    beforeEach(() => {
      useStore(open);
    });

    describe("sweep", () => {
      it("sweep stops VMs with our labels and no row, ignoring other instances and the harness", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const other = createContainers({
          instanceLabel: "instance-b",
          runtime,
          store: newStore(),
        });
        const mine = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });

        const kept = await mine.start(CONTAINER_SPEC);
        const orphan = await mine.start(CONTAINER_SPEC);
        await store.commit({ deleteContainers: [orphan.id] });
        const foreign = await other.start(CONTAINER_SPEC);
        await runtime.create({
          cpus: 1,
          detached: false,
          disableNetwork: false,
          env: {},
          image: "x",
          labels: {
            [CONTAINER_MANAGED_BY_LABEL]: CONTAINER_MANAGED_BY_VALUE,
            [CONTAINER_RUNTIME_SCOPE_LABEL]: "scope",
            [CONTAINER_ENVIRONMENT_ID_LABEL]: "harness-vm",
          },
          memoryMib: 1,
          mounts: [],
          name: "harness-vm",
          ports: [],
          pull: "missing",
          workdir: "/w",
        });

        expect(await mine.sweep()).toEqual([`${orphan.id}-1`]);
        const byName = new Map(runtime.instances.map((i) => [i.id, i.removed]));
        expect(byName.get(`${kept.id}-1`)).toBe(false);
        expect(byName.get(`${orphan.id}-1`)).toBe(true);
        expect(byName.get(`${foreign.id}-1`)).toBe(false);
        expect(byName.get("harness-vm")).toBe(false);
        await kept.close();
        await foreign.close();
      });

      it("leaves, in a sweep, a VM with this instance's labels that no row's id labels", async () => {
        const { runtime, containers } = fixture();
        const instance = await runtime.create({
          cpus: 1,
          detached: false,
          disableNetwork: true,
          env: {},
          image: "test-image",
          labels: {
            [CONTAINER_MANAGED_BY_LABEL]: CONTAINER_MANAGED_BY_VALUE,
            [CONTAINER_INSTANCE_LABEL]: "instance-a",
          },
          memoryMib: 512,
          mounts: [],
          name: "unlabelled",
          ports: [],
          pull: "missing",
          workdir: "/work",
        });
        expect(await containers.sweep()).toEqual([]);
        expect(instance.removed).toBe(false);
        await containers.shutdown();
      });

      it("sweeps only VMs that carry its own store's identity: another store's live VM, under the same instance label, is passed over and named", async () => {
        const runtime = createFakeContainerRuntime();
        const ours = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store: newStore(),
        });
        const theirs = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store: new MemoryContainerStore(),
        });
        const held = await theirs.start(CONTAINER_SPEC);
        const name = held.row.nativeId ?? "";
        const swept = await ours.sweep();
        expect([...swept]).toEqual([]);
        expect(swept.passedOver).toEqual([name]);
        expect(runtime.instances.find((i) => i.id === name)?.removed).toBe(
          false
        );
        const recovered = await ours.recover(() => true);
        expect(recovered.passedOver).toEqual([name]);
        await held.close();
        await theirs.shutdown();
        await ours.shutdown();
      });
    });

    describe("recovery", () => {
      it("recover removes the rows a gone process left, with their VMs, and sweeps VMs with no row, once", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const running = await gone.start(CONTAINER_SPEC);
        const vanished = await gone.start(CONTAINER_SPEC);
        const unrowed = await gone.start(CONTAINER_SPEC);
        await runtime.stopResource(`${vanished.id}-1`);
        await runtime.removeResource(`${vanished.id}-1`);
        await store.commit({ deleteContainers: [unrowed.id] });

        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const mine = await next.start(CONTAINER_SPEC);
        const asked: string[] = [];
        const recovered = await next.recover((row) => {
          asked.push(row.id);
          return row.id !== mine.id;
        });

        expect(asked).toEqual([running.id, vanished.id]);
        expect(recovered).toEqual({
          conflicts: [],
          kept: [],
          passedOver: [],
          removed: [running.id, vanished.id],
          swept: [`${unrowed.id}-1`],
        });
        expect((await store.list()).map((row) => row.id)).toEqual([mine.id]);
        const byName = new Map(runtime.instances.map((i) => [i.id, i.removed]));
        expect(byName.get(`${running.id}-1`)).toBe(true);
        expect(byName.get(`${unrowed.id}-1`)).toBe(true);
        expect(byName.get(`${mine.id}-1`)).toBe(false);

        expect(await next.recover(() => true)).toEqual({
          conflicts: [],
          kept: [],
          passedOver: [],
          removed: [],
          swept: [],
        });
        expect((await store.list()).map((row) => row.id)).toEqual([mine.id]);
        await mine.close();
        await next.shutdown();
      });

      it("keeps the row of a VM a recovery could not remove, removing, and the next recovery takes it over and removes it", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const stop = runtime.stopResource.bind(runtime);
        const runtimeDown: { now: boolean } = { now: true };
        runtime.stopResource = async (name) => {
          if (runtimeDown.now) {
            throw new Error("runtime offline");
          }
          await stop(name);
        };

        const first = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        expect(await first.recover(() => true)).toEqual({
          conflicts: [],
          kept: [left.id],
          passedOver: [],
          removed: [],
          swept: [],
        });
        expect(await store.get(left.id)).toMatchObject({ status: "removing" });
        expect(runtime.instances[0]?.removed).toBe(false);

        runtimeDown.now = false;
        const second = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        expect(await second.recover(() => true)).toEqual({
          conflicts: [],
          kept: [],
          passedOver: [],
          removed: [left.id],
          swept: [],
        });
        expect(await store.list()).toEqual([]);
        expect(runtime.instances[0]?.removed).toBe(true);
        await second.shutdown();
      });

      it("leaves a row to the Containers that opened it while a recovery was judging it", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const row = await gone.start(CONTAINER_SPEC);
        const recovering = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const winner = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        let judged = (): void => undefined;
        let go = (): void => undefined;
        const asked = new Promise<void>((resolve) => {
          judged = resolve;
        });
        const proceed = new Promise<void>((resolve) => {
          go = resolve;
        });
        const recovery = recovering.recover(async () => {
          judged();
          await proceed;
          return true;
        });
        await asked;
        const opened = await winner.open(row.id);
        go();

        expect(await recovery).toEqual({
          conflicts: [],
          kept: [],
          passedOver: [],
          removed: [],
          swept: [],
        });
        const live = runtime.instances.at(-1);
        expect(live?.removed).toBe(false);
        expect(await store.get(row.id)).toMatchObject({ status: "running" });
        const holders: (string | undefined)[] = [];
        await recovering.recover((seen) => {
          holders.push(seen.holder);
          return false;
        });
        expect(holders).toEqual([opened.row.holder]);
        await opened.close();
        await winner.shutdown();
        await recovering.shutdown();
      });

      it.each(["created", "starting", "paused"] as const)(
        "sweeps an orphan in the %s runtime state",
        async (status) => {
          const { runtime, containers, store } = fixture();
          const id = globalThis.crypto.randomUUID();
          const own = await store.identity();
          try {
            const instance = await runtime.create({
              cpus: 1,
              detached: false,
              disableNetwork: true,
              env: {},
              image: "test-image",
              labels: {
                [CONTAINER_MANAGED_BY_LABEL]: CONTAINER_MANAGED_BY_VALUE,
                [CONTAINER_INSTANCE_LABEL]: "instance-a",
                [CONTAINER_ID_LABEL]: id,
                [CONTAINER_STORE_LABEL]: own,
              },
              memoryMib: 512,
              mounts: [],
              name: `${id}-1`,
              ports: [],
              pull: "missing",
              workdir: "/work",
            });
            instance.nativeStatus = status;
            await expect(containers.sweep()).resolves.toEqual([instance.id]);
            expect(instance.removed).toBe(true);
            expect(instance.stopped).toBe(status !== "created");
          } finally {
            await containers.shutdown();
          }
        }
      );
    });

    describe("removal and conflicts", () => {
      it("removes every VM of a row it deletes, so a start cut short after the delete leaves none for the next to miss", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const row = await store.get(left.id);
        if (row === undefined) {
          throw new Error("no row");
        }
        await store.commit({
          putContainers: [
            { ...row, nativeId: `${left.id}-2`, status: "starting" },
          ],
        });

        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const dies = new AbortController();
        await expect(
          next.recover(() => {
            dies.abort();
            return true;
          }, dies.signal)
        ).rejects.toThrow("cancelled");

        expect(await store.list()).toEqual([]);
        expect(
          runtime.instances.find((i) => i.id === `${left.id}-1`)?.removed
        ).toBe(true);
        await next.shutdown();
      });

      it("remove deletes a row only with every VM labelled with its id", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const row = await store.get(left.id);
        if (row === undefined) {
          throw new Error("no row");
        }
        await store.commit({
          putContainers: [
            { ...row, nativeId: `${left.id}-2`, status: "starting" },
          ],
        });
        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });

        await runtime.stopResource(`${left.id}-1`);
        const stop = runtime.stopResource.bind(runtime);
        runtime.stopResource = (name) =>
          name === `${left.id}-1`
            ? Promise.reject(new Error("already stopped"))
            : stop(name);

        await next.remove(left.id);

        expect(await store.list()).toEqual([]);
        expect(
          runtime.instances.find((i) => i.id === `${left.id}-1`)?.removed
        ).toBe(true);
        await next.shutdown();
      });

      it("never removes a VM another row records, whatever its label says: the row is kept, removing, and the conflict named", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const other = await gone.start(CONTAINER_SPEC);
        const vm = `${left.id}-1`;
        const leftRow = await store.get(left.id);
        const otherRow = await store.get(other.id);
        if (leftRow === undefined || otherRow === undefined) {
          throw new Error("no rows");
        }
        await store.commit({
          putContainers: [
            { ...leftRow, nativeId: `${left.id}-2` },
            { ...otherRow, holder: "alive", nativeId: vm, status: "running" },
          ],
        });

        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const recovered = await next.recover((row) => row.id === left.id);

        expect(recovered).toEqual({
          conflicts: [vm],
          kept: [left.id],
          passedOver: [],
          removed: [],
          swept: [],
        });
        const instance = runtime.instances.find((i) => i.id === vm);
        expect(instance?.removed).toBe(false);
        expect(instance?.stopped).toBe(false);
        expect(await store.get(left.id)).toMatchObject({ status: "removing" });
        expect(await store.get(other.id)).toMatchObject({
          nativeId: vm,
          status: "running",
        });
        await expect(next.remove(left.id)).rejects.toThrow(vm);

        await store.commit({ deleteContainers: [left.id] });
        expect(await next.sweep()).not.toContain(vm);
        expect(instance?.removed).toBe(false);
        await next.shutdown();
      });

      it("asks afresh, right before each VM it removes, whether another row records it", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const other = await gone.start(CONTAINER_SPEC);
        const row = await store.get(left.id);
        const otherRow = await store.get(other.id);
        if (row === undefined || otherRow === undefined) {
          throw new Error("no rows");
        }
        await store.commit({
          putContainers: [
            { ...row, nativeId: `${left.id}-2`, status: "starting" },
          ],
        });
        await runtime.create({
          cpus: 1,
          detached: false,
          disableNetwork: false,
          env: {},
          image: "x",
          labels: {
            [CONTAINER_MANAGED_BY_LABEL]: CONTAINER_MANAGED_BY_VALUE,
            [CONTAINER_INSTANCE_LABEL]: "instance-a",
            [CONTAINER_ID_LABEL]: left.id,
          },
          memoryMib: 1,
          mounts: [],
          name: `${left.id}-2`,
          ports: [],
          pull: "missing",
          workdir: "/w",
        });
        const names = [`${left.id}-1`, `${left.id}-2`];
        const stop = runtime.stopResource.bind(runtime);
        let claimed: string | undefined;
        runtime.stopResource = async (name) => {
          if (claimed === undefined && names.includes(name)) {
            claimed = names.find((each) => each !== name);
            await store.commit({
              putContainers: [
                {
                  ...otherRow,
                  holder: "alive",
                  nativeId: claimed,
                  status: "running",
                },
              ],
            });
          }
          await stop(name);
        };
        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });

        const recovered = await next.recover((each) => each.id === left.id);

        expect(recovered).toMatchObject({
          conflicts: [claimed],
          kept: [left.id],
          passedOver: [claimed],
          removed: [],
        });
        const instance = runtime.instances.find((i) => i.id === claimed);
        expect(instance?.removed).toBe(false);
        expect(instance?.stopped).toBe(false);
        await next.shutdown();
      });

      it("never acts on a VM whose name is not its labelled row's own, nor writes a row recording another's", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const other = await gone.start(CONTAINER_SPEC);
        const list = runtime.listResources.bind(runtime);
        runtime.listResources = async (query) => {
          const listed = await list(query);
          return {
            ...listed,
            resources: listed.resources.map((resource) =>
              resource.name === `${other.id}-1`
                ? {
                    ...resource,
                    labels: {
                      ...resource.labels,
                      [CONTAINER_ID_LABEL]: left.id,
                    },
                  }
                : resource
            ),
          };
        };
        await store.commit({ deleteContainers: [other.id] });
        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const recovered = await next.recover((each) => each.id === left.id);
        expect(recovered).toMatchObject({
          conflicts: [`${other.id}-1`],
          kept: [left.id],
        });
        expect(await next.sweep()).not.toContain(`${other.id}-1`);
        const instance = runtime.instances.find(
          (i) => i.id === `${other.id}-1`
        );
        expect(instance?.removed).toBe(false);

        const row = await store.get(left.id);
        if (row === undefined) {
          throw new Error("no row");
        }
        await store.commit({
          putContainers: [
            { ...row, nativeId: `${other.id}-1`, status: "stopped" },
          ],
        });
        await expect(next.restart(left.id, CONTAINER_SPEC)).rejects.toThrow(
          "records the native name"
        );
        await next.shutdown();
      });

      it("never removes a VM named as a row's own but labelled with another row's id: a conflict, left", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const other = await gone.start(CONTAINER_SPEC);
        const list = runtime.listResources.bind(runtime);
        runtime.listResources = async (query) => {
          const listed = await list(query);
          return {
            ...listed,
            resources: listed.resources.map((resource) =>
              resource.name === `${left.id}-1`
                ? {
                    ...resource,
                    labels: {
                      ...resource.labels,
                      [CONTAINER_ID_LABEL]: other.id,
                    },
                  }
                : resource
            ),
          };
        };
        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        expect(await next.recover((each) => each.id === left.id)).toMatchObject(
          {
            conflicts: [`${left.id}-1`],
            kept: [left.id],
            passedOver: [`${left.id}-1`],
            removed: [],
          }
        );
        const instance = runtime.instances.find((i) => i.id === `${left.id}-1`);
        expect(instance?.removed).toBe(false);
        expect(instance?.stopped).toBe(false);
        await next.shutdown();
      });

      it("never abandons, nor reclaims, a previous VM that is not the reopened row's own", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const holder = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const held = await holder.start(CONTAINER_SPEC);
        const heldName = held.row.nativeId ?? "";
        const stray = "33333333-3333-4333-8333-333333333333";
        await store.commit({
          putContainers: [
            {
              createdAt: 1,
              holder: "dead",
              id: stray,
              nativeId: heldName,
              spec: JSON.stringify(CONTAINER_SPEC),
              status: "running",
              updatedAt: 1,
            },
          ],
        });
        const stop = runtime.stopResource.bind(runtime);
        let failed = false;
        runtime.stopResource = (name) => {
          if (!failed && name === heldName) {
            failed = true;
            return Promise.reject(new Error("transient"));
          }
          return stop(name);
        };
        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const reopened = await next.open(stray);
        await next.sweep();
        await next.shutdown().catch(() => undefined);
        const instance = runtime.instances.find((i) => i.id === heldName);
        expect(instance?.removed).toBe(false);
        expect(instance?.stopped).toBe(false);
        expect(await store.get(held.id)).toMatchObject({ status: "running" });
        await reopened.close().catch(() => undefined);
        await held.close();
        await holder.shutdown();
      });
    });

    describe("reporting", () => {
      it("keeps the old VM of a reopened row to retry, and says so, when the inventory cannot be read", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const lines: string[] = [];
        const next = createContainers({
          instanceLabel: "instance-a",
          report: (line) => lines.push(line),
          runtime,
          store,
        });
        const list = runtime.listResources.bind(runtime);
        let failing = true;
        runtime.listResources = (query) => {
          if (failing) {
            failing = false;
            return Promise.reject(new Error("inventory down"));
          }
          return list(query);
        };
        const reopened = await next.open(left.id);
        expect(lines).toEqual([expect.stringContaining(`${left.id}-1`)]);
        const old = runtime.instances.find((i) => i.id === `${left.id}-1`);
        expect(old?.removed).toBe(false);
        expect([...(await next.sweep())]).toEqual([`${left.id}-1`]);
        expect(old?.removed).toBe(true);
        await reopened.close();
        await next.shutdown();
      });

      it("goes on, and boots, when its reporter throws", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const next = createContainers({
          instanceLabel: "instance-a",
          report: () => {
            throw new Error("the reporter broke");
          },
          runtime,
          store,
        });
        const list = runtime.listResources.bind(runtime);
        let failing = true;
        runtime.listResources = (query) => {
          if (failing) {
            failing = false;
            return Promise.reject(new Error("inventory down"));
          }
          return list(query);
        };
        const reopened = await next.open(left.id);
        expect(await store.get(left.id)).toMatchObject({
          nativeId: `${left.id}-2`,
          status: "running",
        });
        expect([...(await next.sweep())]).toEqual([`${left.id}-1`]);
        await reopened.close();
        await next.shutdown();
      });

      it("names, in what it reports, a way to remove a running VM by hand", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const list = runtime.listResources.bind(runtime);
        runtime.listResources = async (query) => {
          const listed = await list(query);
          return {
            ...listed,
            resources: listed.resources.map((resource) => ({
              ...resource,
              labels: {
                ...resource.labels,
                [CONTAINER_STORE_LABEL]: "another",
              },
            })),
          };
        };
        const lines: string[] = [];
        const next = createContainers({
          instanceLabel: "instance-a",
          report: (line) => lines.push(line),
          runtime,
          store,
        });
        const reopened = await next.open(left.id);
        expect(lines).toEqual([
          expect.stringContaining(`msb rm -f ${left.id}-1`),
        ]);
        expect(lines[0]).toContain("node_modules/.bin/msb");
        await reopened.close();
        await next.shutdown();
      });
    });
  }
);
