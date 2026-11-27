import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContainers } from "../containers/containers";
import {
  CONTAINER_ID_LABEL,
  CONTAINER_INSTANCE_LABEL,
  CONTAINER_MANAGED_BY_LABEL,
  CONTAINER_MANAGED_BY_VALUE,
} from "../containers/defaults";
import type { ContainerSpecInput } from "../containers/spec";
import { createFakeDriver } from "../testing/index";
import {
  CONTAINER_SPEC,
  CONTAINER_STORES,
  fixture,
  gatedStore,
  newStore,
  puts,
  useStore,
} from "./helpers/containers-fixture";

const MISSING_HYPERVISOR_ERROR = /no hypervisor/;
const MISSING_CONTAINER_ERROR = /does not exist/;
const DUPLICATE_CONTAINER_ERROR = /already exists/;
const REMOVING_CONTAINER_ERROR = /being removed/;
const CLOSED_DURING_RESTART_ERROR = /closed before its restart finished/;
const INVALID_SPEC_ERROR = /invalid container spec/;
const LIVE_CONTAINER_ERROR = /live/;
const SHUTDOWN_ERROR = /shut down/;
const FILES_MOUNT_PATH = /\/foundry\/files/;

describe.each(CONTAINER_STORES)("containers over %s", (_name, open) => {
  beforeEach(() => {
    useStore(open);
  });

  describe("creation and opening", () => {
    it("resolves every spec over the containers' config defaults", async () => {
      const runtime = createFakeDriver();
      const containers = createContainers({
        defaults: {
          env: { NODE_ENV: "production", TZ: "UTC" },
          image: "docker.io/library/alpine:3",
          labels: { team: "core" },
          network: "open",
          pull: "never",
        },
        driver: runtime,
        instanceLabel: "defaults",
        store: newStore(),
      });

      const inherited = await containers.start({
        format: "foundry.sandbox.container/1",
      });
      expect(runtime.handles[0]?.spec).toMatchObject({
        env: { NODE_ENV: "production", TZ: "UTC" },
        image: "docker.io/library/alpine:3",
        labels: { team: "core" },
        network: "open",
        pull: "never",
      });

      const own = await containers.start({
        format: "foundry.sandbox.container/1",
        image: "docker.io/oven/bun:1",
        labels: { team: "edge" },
        network: "none",
        publicEnvironment: { NODE_ENV: "test" },
      });
      expect(runtime.handles[1]?.spec).toMatchObject({
        env: { NODE_ENV: "test", TZ: "UTC" },
        image: "docker.io/oven/bun:1",
        labels: { team: "edge" },
        network: "none",
        pull: "never",
      });

      await inherited.close();
      await own.close();
    });

    it("start inserts a row, boots a labeled VM, and hands back a ready sandbox", async () => {
      const { runtime, store, containers } = fixture();
      const c = await containers.start(CONTAINER_SPEC);

      const row = await store.get(c.id);
      expect(row).toMatchObject({
        id: c.id,
        nativeId: `${c.id}-1`,
        status: "running",
      });
      expect(JSON.parse(row?.spec ?? "")).toEqual(CONTAINER_SPEC);
      expect(runtime.handles[0]?.spec.labels).toMatchObject({
        [CONTAINER_MANAGED_BY_LABEL]: CONTAINER_MANAGED_BY_VALUE,
        [CONTAINER_INSTANCE_LABEL]: "instance-a",
        [CONTAINER_ID_LABEL]: c.id,
      });
      expect(runtime.handles[0]?.spec.image).toBe("docker.io/oven/bun:1");
      expect(c.volumes).toBeUndefined();
      expect(c).not.toHaveProperty("native");
      await c.commands.exec(["echo", "hi"]);
      expect(runtime.handles[0]?.commands).toContainEqual(["echo", "hi"]);
      await c.close();
    });

    it("open on a live row shares the sandbox; the last close stops the VM", async () => {
      const { runtime, store, containers } = fixture();
      const first = await containers.start(CONTAINER_SPEC);
      const second = await containers.open(first.id);
      expect(second.files).toBe(first.files);
      expect(runtime.handles).toHaveLength(1);

      await first.close();
      await first.close();
      expect(runtime.handles[0]?.removed).toBe(false);
      expect((await store.get(first.id))?.status).toBe("running");

      await second.close();
      expect(runtime.handles[0]?.removed).toBe(true);
      expect((await store.get(first.id))?.status).toBe("stopped");
      expect(await containers.list()).toHaveLength(1);
    });

    it("open restarts a stopped row under the same id with the next native name", async () => {
      const { runtime, store, containers } = fixture();
      const first = await containers.start(CONTAINER_SPEC);
      await first.close();

      const again = await containers.open(first.id);
      expect(again.id).toBe(first.id);
      expect(again.files).not.toBe(first.files);
      expect(runtime.handles.map((i) => i.id)).toEqual([
        `${first.id}-1`,
        `${first.id}-2`,
      ]);
      expect((await store.get(first.id))?.nativeId).toBe(`${first.id}-2`);
      await again.close();
    });

    it("open after a process restart removes the old native and boots anew", async () => {
      const runtime = createFakeDriver();
      const store = newStore();
      const before = createContainers({
        driver: runtime,
        instanceLabel: "instance-a",
        store,
      });
      const c = await before.start(CONTAINER_SPEC);
      const after = createContainers({
        driver: runtime,
        instanceLabel: "instance-a",
        store,
      });
      const reopened = await after.open(c.id);
      expect(runtime.handles[0]?.removed).toBe(true);
      expect(runtime.handles[1]?.id).toBe(`${c.id}-2`);
      expect(reopened.row.status).toBe("running");
      await reopened.close();
    });

    it("boots attached by default and detached only when the spec says so", async () => {
      const { runtime, containers } = fixture();
      const attached = await containers.start(CONTAINER_SPEC);
      const detached = await containers.start({
        ...CONTAINER_SPEC,
        detached: true,
      });
      expect(runtime.handles.map((i) => i.spec.detached)).toEqual([
        false,
        true,
      ]);
      await attached.close();
      await detached.close();
    });

    it("marks the row failed when the VM will not boot", async () => {
      const runtime = createFakeDriver();
      runtime.create = () => Promise.reject(new Error("no hypervisor"));
      const store = newStore();
      const containers = createContainers({
        driver: runtime,
        instanceLabel: "instance-a",
        store,
      });
      await expect(containers.start(CONTAINER_SPEC)).rejects.toThrow(
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
        containers.start({ ...CONTAINER_SPEC, ports: [3000, 3000] })
      ).rejects.toThrow(INVALID_SPEC_ERROR);
    });
  });

  describe("restart", () => {
    it("restart replaces the VM under open handles, with a new spec when given", async () => {
      const { store, writes } = gatedStore({ transactional: true });
      const runtime = createFakeDriver();
      const containers = createContainers({
        driver: runtime,
        instanceLabel: "instance-a",
        store,
      });
      const a = await containers.start(CONTAINER_SPEC);
      const b = await containers.open(a.id);
      const before = a.files;
      writes.length = 0;

      await containers.restart(a.id, {
        ...CONTAINER_SPEC,
        ports: [3000, 5173],
      });

      expect(puts(writes)).toEqual([
        { nativeId: `${a.id}-1`, status: "restarting" },
        { nativeId: `${a.id}-2`, status: "restarting" },
        { nativeId: `${a.id}-2`, status: "running" },
      ]);
      expect(runtime.handles[0]?.removed).toBe(true);
      expect(runtime.handles[1]?.id).toBe(`${a.id}-2`);
      expect(runtime.handles[1]?.spec.ports).toEqual([3000, 5173]);
      expect(a.files).not.toBe(before);
      expect(a.files).toBe(b.files);
      expect(JSON.parse((await store.get(a.id))?.spec ?? "")).toMatchObject({
        ports: [3000, 5173],
      });

      await containers.restart(a.id);
      expect(runtime.handles[2]?.id).toBe(`${a.id}-3`);
      await a.close();
      expect(runtime.handles[2]?.removed).toBe(false);
      await b.close();
      expect(runtime.handles[2]?.removed).toBe(true);
      expect((await store.get(a.id))?.status).toBe("stopped");
    });

    it("restart on a row not live here only records the new spec for the next open", async () => {
      const { runtime, store, containers } = fixture();
      const c = await containers.start(CONTAINER_SPEC);
      await c.close();
      await containers.restart(c.id, {
        ...CONTAINER_SPEC,
        image: "docker.io/library/node:22",
      });
      expect(runtime.handles).toHaveLength(1);
      expect((await store.get(c.id))?.status).toBe("stopped");
      const reopened = await containers.open(c.id);
      expect(runtime.handles[1]?.spec.image).toBe("docker.io/library/node:22");
      await reopened.close();
    });
  });

  describe("stored rows", () => {
    it("keeps the memory store when given none", async () => {
      const containers = createContainers({
        driver: createFakeDriver(),
        instanceLabel: "instance-a",
      });
      const c = await containers.start(CONTAINER_SPEC);
      expect((await containers.list()).map((row) => row.status)).toEqual([
        "running",
      ]);
      await c.close();
      expect((await containers.list())[0]?.status).toBe("stopped");
    });

    it("refuses to write back a row deleted under a live handle", async () => {
      const { store, containers } = fixture();
      const c = await containers.start(CONTAINER_SPEC);
      await store.commit({ deleteContainers: [c.id] });
      await expect(c.close()).rejects.toThrow(MISSING_CONTAINER_ERROR);
      expect(await store.get(c.id)).toBeUndefined();
    });

    it("commits a new row once, under its first native name, before the VM boots", async () => {
      const { store, writes } = gatedStore();
      const containers = createContainers({
        driver: createFakeDriver(),
        instanceLabel: "instance-a",
        store,
      });
      const c = await containers.start(CONTAINER_SPEC);
      expect(puts(writes)).toEqual([
        { nativeId: `${c.id}-1`, status: "starting" },
        { nativeId: `${c.id}-1`, status: "running" },
      ]);
      await c.close();
      writes.length = 0;

      const reopened = await containers.open(c.id);
      expect(puts(writes)).toEqual([
        { nativeId: `${c.id}-2`, status: "starting" },
        { nativeId: `${c.id}-2`, status: "running" },
      ]);
      await reopened.close();
    });
  });

  describe("removal and shutdown", () => {
    it("remove deletes a closed row and refuses a live one", async () => {
      const { runtime, store, containers } = fixture();
      const c = await containers.start(CONTAINER_SPEC);
      await expect(containers.remove(c.id)).rejects.toThrow(
        LIVE_CONTAINER_ERROR
      );
      await c.close();
      await containers.remove(c.id);
      expect(await store.get(c.id)).toBeUndefined();
      expect(runtime.handles[0]?.removed).toBe(true);
      await expect(containers.remove(c.id)).rejects.toThrow(
        MISSING_CONTAINER_ERROR
      );
    });

    it("shutdown stops everything and refuses further use", async () => {
      const { runtime, store, containers } = fixture();
      const a = await containers.start(CONTAINER_SPEC);
      const b = await containers.start(CONTAINER_SPEC);
      await containers.shutdown();
      expect(runtime.handles.every((i) => i.removed)).toBe(true);
      expect((await store.get(a.id))?.status).toBe("stopped");
      expect((await store.get(b.id))?.status).toBe("stopped");
      await expect(containers.open(a.id)).rejects.toThrow(SHUTDOWN_ERROR);
      await a.close();
    });
  });

  describe("mounts", () => {
    it("resolves mounts under the allowlist and target root, exposing volumes", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "foundry-containers-")
      );
      const source = path.join(directory, "files", "installation-1");
      await mkdir(source, { recursive: true });
      try {
        const runtime = createFakeDriver();
        const containers = createContainers({
          driver: runtime,
          instanceLabel: "instance-a",
          mountTargetRoot: "/foundry/files",
          store: newStore(),
        });
        const mount = {
          access: "read-write" as const,
          id: "files",
          source,
          target: "/foundry/files",
        };
        const spec: ContainerSpecInput = {
          format: "foundry.sandbox.container/1",
          mounts: [mount],
        };
        const c = await containers.start(spec);
        expect(runtime.handles[0]?.spec.mounts).toEqual([
          {
            access: "read-write",
            id: "files",
            source: { kind: "host-directory", path: source },
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
});

describe.each(CONTAINER_STORES)("containers racing over %s", (_name, open) => {
  beforeEach(() => {
    useStore(open);
  });

  describe("concurrent opens and closes", () => {
    it("concurrent opens on one stopped row share a single start", async () => {
      const { runtime, containers } = fixture();
      const c = await containers.start(CONTAINER_SPEC);
      await c.close();
      const [a, b] = await Promise.all([
        containers.open(c.id),
        containers.open(c.id),
      ]);
      expect(a.files).toBe(b.files);
      expect(runtime.handles).toHaveLength(2);
      await a.close();
      expect(runtime.handles[1]?.removed).toBe(false);
      await b.close();
      expect(runtime.handles[1]?.removed).toBe(true);
    });

    it("open during the last close waits for the stop, then boots anew", async () => {
      const { runtime, store, containers } = fixture();
      const c = await containers.start(CONTAINER_SPEC);
      const [vm] = runtime.handles;
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
      expect(runtime.handles).toHaveLength(1);
      finishRemove();
      const reopened = await reopening;
      await closing;

      expect(runtime.handles.map((i) => i.removed)).toEqual([true, false]);
      expect(reopened.row.status).toBe("running");
      expect((await store.get(c.id))?.status).toBe("running");
      await reopened.close();
      expect((await store.get(c.id))?.status).toBe("stopped");
    });
  });

  describe("writes racing a reopen", () => {
    it("keeps a spec recorded while a reopen is writing its native name", async () => {
      const { hold, store } = gatedStore();
      const containers = createContainers({
        driver: createFakeDriver(),
        instanceLabel: "instance-a",
        store,
      });
      const c = await containers.start(CONTAINER_SPEC);
      await c.close();
      const alpine = { ...CONTAINER_SPEC, image: "docker.io/library/alpine:3" };

      const gate = hold(
        (write) => write.putContainers?.[0]?.nativeId === `${c.id}-2`
      );
      const reopening = containers.open(c.id);
      await gate.caught;
      const restarting = containers.restart(c.id, alpine);
      await new Promise((resolve) => setTimeout(resolve, 0));
      gate.release();
      await restarting;
      const reopened = await reopening;

      expect(JSON.parse((await store.get(c.id))?.spec ?? "")).toMatchObject({
        image: "docker.io/library/alpine:3",
      });
      expect((await store.get(c.id))?.nativeId).toBe(`${c.id}-2`);
      await reopened.close();
    });

    it("keeps a spec another Containers instance records while a reopen is writing", async () => {
      const { hold, store } = gatedStore({ transactional: true });
      const runtime = createFakeDriver();
      const first = createContainers({
        driver: runtime,
        instanceLabel: "a",
        store,
      });
      const second = createContainers({
        driver: runtime,
        instanceLabel: "a",
        store,
      });
      const c = await first.start(CONTAINER_SPEC);
      await c.close();
      const alpine = { ...CONTAINER_SPEC, image: "docker.io/library/alpine:3" };

      const gate = hold(
        (write) => write.putContainers?.[0]?.nativeId === `${c.id}-2`
      );
      const reopening = first.open(c.id);
      await gate.caught;
      const restarting = second.restart(c.id, alpine);
      await new Promise((resolve) => setTimeout(resolve, 0));
      gate.release();
      await restarting;
      const reopened = await reopening;

      expect(JSON.parse((await store.get(c.id))?.spec ?? "")).toMatchObject({
        image: "docker.io/library/alpine:3",
      });
      expect((await store.get(c.id))?.nativeId).toBe(`${c.id}-2`);
      await reopened.close();
    });

    it("boots two registries reopening one row under different native names", async () => {
      const { store } = gatedStore({ transactional: true });
      const runtime = createFakeDriver();
      const first = createContainers({
        driver: runtime,
        instanceLabel: "a",
        store,
      });
      const second = createContainers({
        driver: runtime,
        instanceLabel: "a",
        store,
      });
      const c = await first.start(CONTAINER_SPEC);
      await c.close();

      const handles = await Promise.all([first.open(c.id), second.open(c.id)]);
      expect(runtime.handles.map((instance) => instance.id)).toEqual([
        `${c.id}-1`,
        `${c.id}-2`,
        `${c.id}-3`,
      ]);
      await Promise.all(handles.map((handle) => handle.close()));
    });
  });

  describe("rows being created or removed", () => {
    it("refuses a new row whose generated id is already taken", async () => {
      const { store, containers } = fixture();
      const first = await containers.start(CONTAINER_SPEC);
      await first.close();
      const before = await store.get(first.id);
      const uuid = vi
        .spyOn(globalThis.crypto, "randomUUID")
        .mockReturnValue(first.id as ReturnType<Crypto["randomUUID"]>);
      try {
        await expect(
          containers.start({
            ...CONTAINER_SPEC,
            image: "docker.io/library/alpine:3",
          })
        ).rejects.toThrow(DUPLICATE_CONTAINER_ERROR);
      } finally {
        uuid.mockRestore();
      }
      expect(await store.get(first.id)).toEqual(before);
      expect(await containers.list()).toHaveLength(1);
    });

    it("refuses an open that begins while the row is being removed", async () => {
      const { hold, store } = gatedStore({ transactional: true });
      const runtime = createFakeDriver();
      const containers = createContainers({
        driver: runtime,
        instanceLabel: "instance-a",
        store,
      });
      const c = await containers.start(CONTAINER_SPEC);
      await c.close();

      const gate = hold(
        (write) => write.deleteContainers?.includes(c.id) ?? false
      );
      const removing = containers.remove(c.id);
      await gate.caught;
      const opening = containers.open(c.id);
      const restarting = containers.restart(c.id, CONTAINER_SPEC);
      gate.release();

      await expect(opening).rejects.toThrow(REMOVING_CONTAINER_ERROR);
      await expect(restarting).rejects.toThrow(REMOVING_CONTAINER_ERROR);
      await removing;
      expect(await store.get(c.id)).toBeUndefined();
      expect(runtime.handles).toHaveLength(1);
    });
  });

  describe("restarts racing a close", () => {
    it("stops a restart whose last handle closes and leaves no VM behind", async () => {
      const { hold, store } = gatedStore({ transactional: true });
      const runtime = createFakeDriver();
      const containers = createContainers({
        driver: runtime,
        instanceLabel: "instance-a",
        store,
      });
      const c = await containers.start(CONTAINER_SPEC);

      const gate = hold(
        (write) => write.putContainers?.[0]?.nativeId === `${c.id}-2`
      );
      const restarting = containers.restart(c.id);
      await gate.caught;
      const closing = c.close();
      gate.release();

      await expect(restarting).rejects.toThrow(CLOSED_DURING_RESTART_ERROR);
      await closing;
      expect(runtime.handles.every((instance) => instance.removed)).toBe(true);
      expect((await store.get(c.id))?.status).toBe("stopped");
    });

    it("stops a restart whose last handle closes while it boots", async () => {
      const { hold, store } = gatedStore({ transactional: true });
      const runtime = createFakeDriver();
      const containers = createContainers({
        driver: runtime,
        instanceLabel: "instance-a",
        store,
      });
      const c = await containers.start(CONTAINER_SPEC);

      const gate = hold((write) => {
        const row = write.putContainers?.[0];
        return row?.nativeId === `${c.id}-2` && row.status === "running";
      });
      const restarting = containers.restart(c.id);
      await gate.caught;
      const closing = c.close();
      gate.release();

      await expect(restarting).rejects.toThrow(CLOSED_DURING_RESTART_ERROR);
      await closing;
      expect(runtime.handles).toHaveLength(2);
      expect(runtime.handles.every((instance) => instance.removed)).toBe(true);
      expect((await store.get(c.id))?.status).toBe("stopped");
    });

    it("boots the spec a queued restart left stored when given none", async () => {
      const { runtime, store, containers } = fixture();
      const c = await containers.start(CONTAINER_SPEC);

      await Promise.all([
        containers.restart(c.id, { ...CONTAINER_SPEC, ports: [5173] }),
        containers.restart(c.id),
      ]);

      expect(runtime.handles).toHaveLength(3);
      for (const instance of runtime.handles.slice(1)) {
        expect(instance.spec.ports).toEqual([5173]);
      }
      expect(JSON.parse((await store.get(c.id))?.spec ?? "")).toMatchObject({
        ports: [5173],
      });
      await c.close();
    });
  });
});
