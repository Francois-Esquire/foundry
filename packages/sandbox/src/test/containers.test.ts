import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  CONTAINER_ENVIRONMENT_ID_LABEL,
  CONTAINER_ID_LABEL,
  CONTAINER_INSTANCE_LABEL,
  CONTAINER_MANAGED_BY_LABEL,
  CONTAINER_MANAGED_BY_VALUE,
  CONTAINER_RUNTIME_SCOPE_LABEL,
} from "../container/constants";
import type { ContainerSandboxConstraints } from "../container/constraints";
import { createContainers } from "../container/containers";
import { createMemoryContainerStore } from "../container/store";
import { createFakeContainerRuntime } from "../testing";

const MISSING_HYPERVISOR_ERROR = /no hypervisor/;
const MISSING_CONTAINER_ERROR = /does not exist/;
const INVALID_SPEC_ERROR = /invalid container spec/;
const LIVE_CONTAINER_ERROR = /live/;
const SHUTDOWN_ERROR = /shut down/;
const FILES_MOUNT_PATH = /\/foundry\/files/;

const SPEC: ContainerSandboxConstraints = {
  format: "foundry.sandbox.container/1",
  image: "docker.io/oven/bun:1",
  ports: [3000],
};

function fixture(instanceLabel = "instance-a") {
  const runtime = createFakeContainerRuntime();
  const store = createMemoryContainerStore();
  const containers = createContainers({ instanceLabel, runtime, store });
  return { containers, runtime, store };
}

describe("containers registry", () => {
  it("resolves every spec over the registry's config defaults", async () => {
    const runtime = createFakeContainerRuntime();
    const containers = createContainers({
      config: {
        env: { NODE_ENV: "production", TZ: "UTC" },
        image: "docker.io/library/alpine:3",
        labels: { team: "core" },
        network: "unrestricted",
        pull: "never",
      },
      instanceLabel: "defaults",
      runtime,
      store: createMemoryContainerStore(),
    });

    const inherited = await containers.start({
      format: "foundry.sandbox.container/1",
    });
    expect(runtime.instances[0]?.spec).toMatchObject({
      disableNetwork: false,
      env: { NODE_ENV: "production", TZ: "UTC" },
      image: "docker.io/library/alpine:3",
      labels: { team: "core" },
      network: "unrestricted",
      pull: "never",
    });

    const own = await containers.start({
      format: "foundry.sandbox.container/1",
      image: "docker.io/oven/bun:1",
      labels: { team: "edge" },
      network: "disabled",
      publicEnvironment: { NODE_ENV: "test" },
    });
    expect(runtime.instances[1]?.spec).toMatchObject({
      disableNetwork: true,
      env: { NODE_ENV: "test", TZ: "UTC" },
      image: "docker.io/oven/bun:1",
      labels: { team: "edge" },
      network: "disabled",
      pull: "never",
    });

    await inherited.close();
    await own.close();
  });

  it("start inserts a row, boots a labeled VM, and hands back a ready sandbox", async () => {
    const { runtime, store, containers } = fixture();
    const c = await containers.start(SPEC);

    const row = await store.get(c.id);
    expect(row).toMatchObject({
      id: c.id,
      nativeId: `${c.id}-1`,
      status: "running",
    });
    expect(JSON.parse(row?.spec ?? "")).toEqual(SPEC);
    expect(runtime.instances[0]?.spec.labels).toMatchObject({
      [CONTAINER_MANAGED_BY_LABEL]: CONTAINER_MANAGED_BY_VALUE,
      [CONTAINER_INSTANCE_LABEL]: "instance-a",
      [CONTAINER_ID_LABEL]: c.id,
    });
    expect(runtime.instances[0]?.spec.image).toBe("docker.io/oven/bun:1");
    expect(c.volumes).toBeUndefined();
    expect(c).not.toHaveProperty("native");
    await c.commands.exec(["echo", "hi"]);
    expect(runtime.instances[0]?.commands).toContainEqual(["echo", "hi"]);
    await c.close();
  });

  it("open on a live row shares the sandbox; the last close stops the VM", async () => {
    const { runtime, store, containers } = fixture();
    const first = await containers.start(SPEC);
    const second = await containers.open(first.id);
    expect(second.files).toBe(first.files);
    expect(runtime.instances).toHaveLength(1);

    await first.close();
    await first.close();
    expect(runtime.instances[0]?.removed).toBe(false);
    expect((await store.get(first.id))?.status).toBe("running");

    await second.close();
    expect(runtime.instances[0]?.removed).toBe(true);
    expect((await store.get(first.id))?.status).toBe("stopped");
    expect(await containers.list()).toHaveLength(1);
  });

  it("open restarts a stopped row under the same id with the next native name", async () => {
    const { runtime, store, containers } = fixture();
    const first = await containers.start(SPEC);
    await first.close();

    const again = await containers.open(first.id);
    expect(again.id).toBe(first.id);
    expect(again.files).not.toBe(first.files);
    expect(runtime.instances.map((i) => i.id)).toEqual([
      `${first.id}-1`,
      `${first.id}-2`,
    ]);
    expect((await store.get(first.id))?.nativeId).toBe(`${first.id}-2`);
    await again.close();
  });

  it("open after a process restart removes the old native and boots anew", async () => {
    const runtime = createFakeContainerRuntime();
    const store = createMemoryContainerStore();
    const before = createContainers({
      instanceLabel: "instance-a",
      runtime,
      store,
    });
    const c = await before.start(SPEC);
    // Simulate Studio dying: the row says running, the VM is still there.
    const after = createContainers({
      instanceLabel: "instance-a",
      runtime,
      store,
    });
    const reopened = await after.open(c.id);
    expect(runtime.instances[0]?.removed).toBe(true);
    expect(runtime.instances[1]?.id).toBe(`${c.id}-2`);
    expect(reopened.row.status).toBe("running");
    await reopened.close();
  });

  it("concurrent opens on one stopped row share a single start", async () => {
    const { runtime, containers } = fixture();
    const c = await containers.start(SPEC);
    await c.close();
    const [a, b] = await Promise.all([
      containers.open(c.id),
      containers.open(c.id),
    ]);
    expect(a.files).toBe(b.files);
    expect(runtime.instances).toHaveLength(2);
    await a.close();
    expect(runtime.instances[1]?.removed).toBe(false);
    await b.close();
    expect(runtime.instances[1]?.removed).toBe(true);
  });

  it("open during the last close waits for the stop, then boots anew", async () => {
    const { runtime, store, containers } = fixture();
    const c = await containers.start(SPEC);
    const [vm] = runtime.instances;
    if (vm === undefined) {
      throw new Error("no VM booted");
    }
    const remove = vm.remove.bind(vm);
    let finishRemove = (): void => undefined;
    vm.remove = () =>
      new Promise<void>((resolve, reject) => {
        finishRemove = () => {
          remove().then(resolve, reject);
        };
      });

    const closing = c.close();
    const reopening = containers.open(c.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.instances).toHaveLength(1);
    finishRemove();
    const reopened = await reopening;
    await closing;

    expect(runtime.instances.map((i) => i.removed)).toEqual([true, false]);
    expect(reopened.row.status).toBe("running");
    expect((await store.get(c.id))?.status).toBe("running");
    await reopened.close();
    expect((await store.get(c.id))?.status).toBe("stopped");
  });

  it("restart replaces the VM under open handles, with a new spec when given", async () => {
    const { runtime, store, containers } = fixture();
    const a = await containers.start(SPEC);
    const b = await containers.open(a.id);
    const before = a.files;
    const statuses: string[] = [];
    const observed = store.update.bind(store);
    store.update = (id, patch) => {
      if (patch.status !== undefined) {
        statuses.push(patch.status);
      }
      return observed(id, patch);
    };

    await containers.restart(a.id, { ...SPEC, ports: [3000, 5173] });

    expect(statuses).toEqual(["restarting", "running"]);
    expect(runtime.instances[0]?.removed).toBe(true);
    expect(runtime.instances[1]?.id).toBe(`${a.id}-2`);
    expect(runtime.instances[1]?.spec.ports.map((p) => p.guestPort)).toEqual([
      3000, 5173,
    ]);
    expect(a.files).not.toBe(before);
    expect(a.files).toBe(b.files);
    expect(JSON.parse((await store.get(a.id))?.spec ?? "")).toMatchObject({
      ports: [3000, 5173],
    });

    await containers.restart(a.id);
    expect(runtime.instances[2]?.id).toBe(`${a.id}-3`);
    await a.close();
    expect(runtime.instances[2]?.removed).toBe(false);
    await b.close();
    expect(runtime.instances[2]?.removed).toBe(true);
    expect((await store.get(a.id))?.status).toBe("stopped");
  });

  it("restart on a row not live here only records the new spec for the next open", async () => {
    const { runtime, store, containers } = fixture();
    const c = await containers.start(SPEC);
    await c.close();
    await containers.restart(c.id, {
      ...SPEC,
      image: "docker.io/library/node:22",
    });
    expect(runtime.instances).toHaveLength(1);
    expect((await store.get(c.id))?.status).toBe("stopped");
    const reopened = await containers.open(c.id);
    expect(runtime.instances[1]?.spec.image).toBe("docker.io/library/node:22");
    await reopened.close();
  });

  it("boots attached by default and detached only when the spec says so", async () => {
    const { runtime, containers } = fixture();
    const attached = await containers.start(SPEC);
    const detached = await containers.start({ ...SPEC, detached: true });
    expect(runtime.instances.map((i) => i.spec.detached)).toEqual([
      false,
      true,
    ]);
    await attached.close();
    await detached.close();
  });

  it("marks the row failed when the VM will not boot", async () => {
    const runtime = createFakeContainerRuntime();
    runtime.create = () => Promise.reject(new Error("no hypervisor"));
    const store = createMemoryContainerStore();
    const containers = createContainers({
      instanceLabel: "instance-a",
      runtime,
      store,
    });
    await expect(containers.start(SPEC)).rejects.toThrow(
      MISSING_HYPERVISOR_ERROR
    );
    const [row] = await containers.list();
    expect(row?.status).toBe("failed");
  });

  it("rejects an unknown id and an invalid spec", async () => {
    const { containers } = fixture();
    await expect(containers.open("nope")).rejects.toThrow(
      MISSING_CONTAINER_ERROR
    );
    await expect(
      containers.start({ ...SPEC, ports: [3000, 3000] })
    ).rejects.toThrow(INVALID_SPEC_ERROR);
  });

  it("sweep stops VMs with our labels and no row, ignoring other instances and the harness", async () => {
    const runtime = createFakeContainerRuntime();
    const store = createMemoryContainerStore();
    const other = createContainers({
      instanceLabel: "instance-b",
      runtime,
      store: createMemoryContainerStore(),
    });
    const mine = createContainers({
      instanceLabel: "instance-a",
      runtime,
      store,
    });

    const kept = await mine.start(SPEC);
    const orphan = await mine.start(SPEC);
    await store.remove(orphan.id);
    const foreign = await other.start(SPEC);
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

  it.each(["created", "starting", "paused"] as const)(
    "sweeps an orphan in the %s runtime state",
    async (status) => {
      const { runtime, containers } = fixture();
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
          },
          memoryMib: 512,
          mounts: [],
          name: `orphan-${status}`,
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

  it("remove deletes a closed row and refuses a live one", async () => {
    const { runtime, store, containers } = fixture();
    const c = await containers.start(SPEC);
    await expect(containers.remove(c.id)).rejects.toThrow(LIVE_CONTAINER_ERROR);
    await c.close();
    await containers.remove(c.id);
    expect(await store.get(c.id)).toBeUndefined();
    expect(runtime.instances[0]?.removed).toBe(true);
    await expect(containers.remove(c.id)).rejects.toThrow(
      MISSING_CONTAINER_ERROR
    );
  });

  it("shutdown stops everything and refuses further use", async () => {
    const { runtime, store, containers } = fixture();
    const a = await containers.start(SPEC);
    const b = await containers.start(SPEC);
    await containers.shutdown();
    expect(runtime.instances.every((i) => i.removed)).toBe(true);
    expect((await store.get(a.id))?.status).toBe("stopped");
    expect((await store.get(b.id))?.status).toBe("stopped");
    await expect(containers.open(a.id)).rejects.toThrow(SHUTDOWN_ERROR);
    await a.close();
  });

  it("resolves mounts under the allowlist and target root, exposing volumes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "foundry-containers-"));
    const source = path.join(directory, "files", "installation-1");
    await mkdir(source, { recursive: true });
    try {
      const runtime = createFakeContainerRuntime();
      const containers = createContainers({
        allowedMountRoots: [path.join(directory, "files")],
        instanceLabel: "instance-a",
        mountTargetRoot: "/foundry/files",
        runtime,
        store: createMemoryContainerStore(),
      });
      const mount = {
        access: "read-write" as const,
        id: "files",
        source,
        target: "/foundry/files",
      };
      const spec: ContainerSandboxConstraints = {
        format: "foundry.sandbox.container/1",
        mounts: [mount],
      };
      const c = await containers.start(spec);
      expect(runtime.instances[0]?.spec.mounts).toEqual([
        {
          id: "files",
          readOnly: false,
          source: await realpath(source),
          target: "/foundry/files",
        },
      ]);
      expect(await c.volumes?.list()).toEqual([
        { access: "read-write", id: "files", target: "/foundry/files" },
      ]);
      await c.close();

      await expect(
        containers.start({
          ...spec,
          mounts: [{ ...mount, target: "/elsewhere" }],
        })
      ).rejects.toThrow(FILES_MOUNT_PATH);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
