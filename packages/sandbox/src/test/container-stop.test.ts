import { describe, expect, it, vi } from "vitest";
import { createContainers } from "../container/containers";
import {
  CONTAINER_ID_LABEL,
  CONTAINER_STORE_LABEL,
} from "../container/defaults";
import type { FakeContainerRuntimeOptions } from "../testing/index";
import { createFakeContainerRuntime } from "../testing/index";
import {
  CONTAINER_SPEC,
  events,
  gatedStore,
} from "./helpers/containers-fixture";

async function stuck(options: FakeContainerRuntimeOptions = {}) {
  const runtime = createFakeContainerRuntime(options);
  const gated = gatedStore();
  const containers = createContainers({
    instanceLabel: "stop",
    runtime,
    store: gated.store,
  });
  const handle = await containers.start(CONTAINER_SPEC);
  const [instance] = runtime.instances;
  if (instance === undefined) {
    throw new Error("expected a booted instance");
  }
  const remove = vi
    .spyOn(instance, "remove")
    .mockRejectedValueOnce(new Error("stuck"));
  await expect(handle.close()).rejects.toThrow("stuck");
  return { containers, handle, instance, remove, runtime, ...gated };
}

describe("stop", () => {
  it.each(["starting", "running", "paused", "draining"] as const)(
    "stops and removes a retained %s VM and keeps its row",
    async (status) => {
      const { containers, handle, instance, writes } = await stuck();
      instance.nativeStatus = status;

      await containers.stop(handle.id);

      expect(instance.stopped).toBe(true);
      expect(instance.removed).toBe(true);
      expect(await containers.get(handle.id)).toMatchObject({
        nativeId: `${handle.id}-1`,
        status: "stopped",
      });
      expect(events(writes).map(([type]) => type)).toEqual([
        "sandbox.created",
        "sandbox.started",
        "sandbox.stopped",
      ]);
      await containers.stop(handle.id);
      await containers.shutdown();
    }
  );

  it.each([
    ["a foreign store", CONTAINER_STORE_LABEL, "foreign-store"],
    ["no store", CONTAINER_STORE_LABEL, undefined],
  ])(
    "never touches a VM with the row's id and name from %s",
    async (_name, label, value) => {
      const { containers, handle, instance, runtime } = await stuck();
      const labels = instance.spec.labels as Record<string, string | undefined>;
      labels[label] = value;
      expect(instance.id).toBe(`${handle.id}-1`);
      expect(labels[CONTAINER_ID_LABEL]).toBe(handle.id);
      const stopResource = vi.spyOn(runtime, "stopResource");
      const removeResource = vi.spyOn(runtime, "removeResource");

      await expect(containers.stop(handle.id)).rejects.toThrow(
        `msb rm -f ${handle.id}-1`
      );

      expect(stopResource).not.toHaveBeenCalled();
      expect(removeResource).not.toHaveBeenCalled();
      expect(instance.removed).toBe(false);
      expect((await containers.get(handle.id))?.status).toBe("running");
    }
  );

  it("keeps a VM that will not go and retries it at shutdown", async () => {
    const failRemove: string[] = [];
    const { containers, handle, instance } = await stuck({
      inventory: { failRemove },
    });
    failRemove.push(instance.id);

    await expect(containers.stop(handle.id)).rejects.toMatchObject({
      code: "provider-failed",
    });
    expect((await containers.get(handle.id))?.status).toBe("running");
    await expect(containers.shutdown()).rejects.toThrow("could not remove");

    failRemove.length = 0;
    await containers.shutdown();
    expect(instance.removed).toBe(true);
  });

  it("rejects when the inventory cannot be read", async () => {
    const failListCalls: number[] = [];
    const { containers, handle, instance, runtime } = await stuck({
      inventory: { failListCalls },
    });
    failListCalls.push(runtime.listed.length + 1);

    await expect(containers.stop(handle.id)).rejects.toMatchObject({
      code: "provider-failed",
    });
    expect(instance.removed).toBe(false);

    await containers.stop(handle.id);
    expect(instance.removed).toBe(true);
    await containers.shutdown();
  });

  it("refuses a live row, an unknown one and one another holder is removing", async () => {
    const runtime = createFakeContainerRuntime();
    const { store } = gatedStore();
    const containers = createContainers({
      instanceLabel: "stop",
      runtime,
      store,
    });
    const handle = await containers.start(CONTAINER_SPEC);
    const stopResource = vi.spyOn(runtime, "stopResource");

    await expect(containers.stop(handle.id)).rejects.toThrow("is live");
    await expect(containers.stop("unknown")).rejects.toThrow("does not exist");
    await handle.close();
    const row = await store.get(handle.id);
    if (row === undefined) {
      throw new Error("expected a row");
    }
    await store.commit({
      putContainers: [{ ...row, holder: "another", status: "removing" }],
    });
    await expect(containers.stop(handle.id)).rejects.toThrow(
      "is being removed"
    );
    expect(stopResource).not.toHaveBeenCalled();
    await containers.shutdown();
  });

  it("finishes before a reopen of the same row boots", async () => {
    const { containers, handle, instance, runtime } = await stuck();

    const stopping = containers.stop(handle.id);
    const reopened = containers.open(handle.id);

    await stopping;
    await expect(reopened).resolves.toMatchObject({ id: handle.id });
    expect(instance.removed).toBe(true);
    expect(runtime.instances[1]?.removed).toBe(false);
    expect((await containers.get(handle.id))?.status).toBe("running");
    await containers.shutdown();
  });
});

function booting() {
  const runtime = createFakeContainerRuntime();
  const gated = gatedStore();
  const create = runtime.create.bind(runtime);
  let resume = (): void => undefined;
  const open = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let entered = (): void => undefined;
  const creating = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(runtime, "create").mockImplementation(async (spec) => {
    entered();
    await open;
    return await create(spec);
  });
  const containers = createContainers({
    instanceLabel: "stop",
    runtime,
    store: gated.store,
  });
  const started = containers.start(CONTAINER_SPEC);
  const inserted = async () => {
    await creating;
    const [row] = await containers.list();
    if (row === undefined) {
      throw new Error("expected an inserted row");
    }
    return row;
  };
  return { containers, inserted, resume, runtime, started, ...gated };
}

describe("a first boot in flight", () => {
  it.each(["stop", "remove"] as const)("refuses %s", async (method) => {
    const { containers, inserted, resume, runtime, started } = booting();
    const { id } = await inserted();

    await expect(containers[method](id)).rejects.toThrow("is live");

    resume();
    await expect(started).resolves.toMatchObject({ id });
    expect(runtime.instances).toHaveLength(1);
    expect(runtime.instances[0]?.removed).toBe(false);
    expect((await containers.get(id))?.status).toBe("running");
    await containers.shutdown();
  });

  it("is joined by open", async () => {
    const { containers, inserted, resume, runtime, started } = booting();
    const { id } = await inserted();

    const opened = containers.open(id);
    resume();
    const [first, second] = await Promise.all([started, opened]);

    expect(second.id).toBe(first.id);
    expect(runtime.instances).toHaveLength(1);
    await first.close();
    expect(runtime.instances[0]?.removed).toBe(false);
    await second.close();
    expect(runtime.instances[0]?.removed).toBe(true);
    await containers.shutdown();
  });

  it("is passed over by recover", async () => {
    const { containers, inserted, resume, runtime, started } = booting();
    const { id } = await inserted();

    await expect(containers.recover(() => true)).resolves.toMatchObject({
      kept: [],
      removed: [],
    });

    resume();
    await started;
    expect(runtime.instances[0]?.removed).toBe(false);
    expect((await containers.get(id))?.status).toBe("running");
    await containers.shutdown();
  });

  it("only has its next spec recorded by restart", async () => {
    const { containers, inserted, resume, runtime, started } = booting();
    const { id } = await inserted();
    const image = "docker.io/library/alpine:3";

    await containers.restart(id, { ...CONTAINER_SPEC, image });
    resume();
    await started;

    expect(runtime.instances.map((each) => each.spec.image)).toEqual([
      CONTAINER_SPEC.image,
    ]);
    const row = await containers.get(id);
    expect(row?.status).toBe("running");
    expect(JSON.parse(row?.spec ?? "")).toMatchObject({ image });
    await containers.shutdown();
  });

  it("is waited for by shutdown, from before its row is written", async () => {
    const runtime = createFakeContainerRuntime();
    const { hold, store } = gatedStore();
    const containers = createContainers({
      instanceLabel: "stop",
      runtime,
      store,
    });
    const insert = hold(
      (write) => write.events?.[0]?.type === "sandbox.created"
    );
    const started = containers.start(CONTAINER_SPEC);
    await insert.caught;

    const stopped = containers.shutdown();
    insert.release();
    await Promise.all([started, stopped]);

    expect(runtime.instances.map((each) => each.removed)).toEqual([true]);
    expect((await store.list()).map((row) => row.status)).toEqual(["stopped"]);
  });

  it("is forgotten once it fails", async () => {
    const runtime = createFakeContainerRuntime();
    vi.spyOn(runtime, "create").mockRejectedValueOnce(new Error("no boot"));
    const { store } = gatedStore();
    const containers = createContainers({
      instanceLabel: "stop",
      runtime,
      store,
    });

    await expect(containers.start(CONTAINER_SPEC)).rejects.toThrow("no boot");
    const [row] = await containers.list();
    if (row === undefined) {
      throw new Error("expected a row");
    }

    await containers.stop(row.id);
    await containers.remove(row.id);
    expect(await containers.list()).toEqual([]);
    await containers.shutdown();
  });
});

describe("closing a handle again after its close failed", () => {
  it("retries the removal and stops the row", async () => {
    const { containers, handle, instance } = await stuck();
    expect(instance.removed).toBe(false);

    await handle.close();
    await handle.close();

    expect(instance.removed).toBe(true);
    expect((await containers.get(handle.id))?.status).toBe("stopped");
    await containers.remove(handle.id);
    expect(await containers.list()).toEqual([]);
    await containers.shutdown();
  });

  it("keeps rejecting while the VM will not go", async () => {
    const failRemove: string[] = [];
    const { containers, handle, instance } = await stuck({
      inventory: { failRemove },
    });
    failRemove.push(instance.id);

    await expect(handle.close()).rejects.toThrow("could not be removed");
    await expect(handle.close()).rejects.toThrow("could not be removed");
    await expect(containers.remove(handle.id)).rejects.toThrow("kept to retry");
    expect((await containers.get(handle.id))?.status).toBe("removing");

    failRemove.length = 0;
    await containers.remove(handle.id);
    await handle.close();
    expect(instance.removed).toBe(true);
    expect(await containers.list()).toEqual([]);
    await containers.shutdown();
  });

  it("never overlaps a reopen started in the same tick", async () => {
    const { containers, handle, runtime, store } = await stuck();
    const get = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce(async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return await get(id);
    });

    const closing = handle.close();
    const reopened = containers.open(handle.id);
    await Promise.all([closing, reopened]);

    expect(runtime.instances[1]?.removed).toBe(false);
    expect((await get(handle.id))?.status).toBe("running");
    await containers.shutdown();
  });

  it("leaves a reopened row alone", async () => {
    const { containers, handle, runtime } = await stuck();
    await containers.open(handle.id);

    await handle.close();

    expect(runtime.instances[1]?.removed).toBe(false);
    expect((await containers.get(handle.id))?.status).toBe("running");
    await containers.shutdown();
  });
});
