import { beforeEach, describe, expect, it } from "vitest";
import { createContainers } from "../node/containers";
import { sandboxEventSchema } from "../store/schema";
import { createFakeContainerRuntime } from "../testing/index";
import {
  CONTAINER_SPEC,
  CONTAINER_STORES,
  events,
  gatedStore,
  useStore,
} from "./helpers/containers-fixture";

const MISSING_HYPERVISOR_ERROR = /no hypervisor/;

describe.each(CONTAINER_STORES)("container events over %s", (_name, open) => {
  beforeEach(() => {
    useStore(open);
  });

  describe("creation and starting", () => {
    it("carries sandbox.created in the insert, then started and stopped as the row enters running and stopped", async () => {
      const { store, writes } = gatedStore({ transactional: true });
      const containers = createContainers({
        instanceLabel: "instance-a",
        runtime: createFakeContainerRuntime(),
        store,
      });
      const c = await containers.start(CONTAINER_SPEC);
      await containers.restart(c.id);
      await c.close();
      const reopened = await containers.open(c.id);
      await reopened.close();
      const again = await containers.open(c.id);
      await containers.shutdown();

      expect(events(writes)).toEqual([
        ["sandbox.created", c.id],
        ["sandbox.started", c.id],
        ["sandbox.started", c.id],
        ["sandbox.stopped", c.id],
        ["sandbox.started", c.id],
        ["sandbox.stopped", c.id],
        ["sandbox.started", c.id],
        ["sandbox.stopped", c.id],
      ]);
      const statuses: Record<string, string> = {
        "sandbox.created": "starting",
        "sandbox.started": "running",
        "sandbox.stopped": "stopped",
      };
      for (const write of writes.filter((w) => w.events !== undefined)) {
        expect(write.putContainers?.[0]?.status).toBe(
          statuses[write.events?.[0]?.type ?? ""]
        );
      }
      const [created] = writes.flatMap((write) => write.events ?? []);
      expect(created).toEqual({
        at: new Date(c.row.createdAt).toISOString(),
        containerId: c.id,
        id: expect.any(String),
        type: "sandbox.created",
      });
      expect(again.id).toBe(c.id);
    });

    it("carries sandbox.started when a row recorded failed is reopened and comes up", async () => {
      const runtime = createFakeContainerRuntime();
      const create = runtime.create.bind(runtime);
      const boot: { refuses: boolean } = { refuses: true };
      runtime.create = (...args) =>
        boot.refuses
          ? Promise.reject(new Error("no hypervisor"))
          : create(...args);
      const { store, writes } = gatedStore({ transactional: true });
      const containers = createContainers({
        instanceLabel: "instance-a",
        runtime,
        store,
      });
      await expect(containers.start(CONTAINER_SPEC)).rejects.toThrow(
        MISSING_HYPERVISOR_ERROR
      );
      const [row] = await containers.list();
      const id = row?.id ?? "";
      boot.refuses = false;
      const handle = await containers.open(id);
      await handle.close();

      expect(events(writes)).toEqual([
        ["sandbox.created", id],
        ["sandbox.failed", id],
        ["sandbox.started", id],
        ["sandbox.stopped", id],
      ]);
    });
  });

  describe("failure and destruction", () => {
    it("carries sandbox.failed once, in the write that records the row failed", async () => {
      const runtime = createFakeContainerRuntime();
      runtime.create = () => Promise.reject(new Error("no hypervisor"));
      const { store, writes } = gatedStore({ transactional: true });
      const containers = createContainers({
        instanceLabel: "instance-a",
        runtime,
        store,
      });
      await expect(containers.start(CONTAINER_SPEC)).rejects.toThrow(
        MISSING_HYPERVISOR_ERROR
      );
      const [row] = await containers.list();
      const id = row?.id ?? "";
      await expect(containers.open(id)).rejects.toThrow(
        MISSING_HYPERVISOR_ERROR
      );

      expect(events(writes)).toEqual([
        ["sandbox.created", id],
        ["sandbox.failed", id],
        ["sandbox.failed", id],
      ]);
      const failing = writes.filter(
        (write) => write.events?.[0]?.type === "sandbox.failed"
      );
      expect(failing.map((write) => write.putContainers?.[0]?.status)).toEqual([
        "failed",
        "failed",
      ]);
      const emitted = writes.flatMap((write) => write.events ?? []);
      const ids = emitted.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const event of emitted) {
        expect(sandboxEventSchema.parse(event)).toStrictEqual(event);
      }
    });

    it("carries sandbox.destroyed once for a row a recovery takes back, and nothing for a claim that changes only its holder", async () => {
      const { store, writes } = gatedStore({ transactional: true });
      const runtime = createFakeContainerRuntime();
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
      const recovery = writes.length;

      await createContainers({
        instanceLabel: "instance-a",
        runtime,
        store,
      }).recover(() => true);
      expect(events(writes.slice(recovery))).toEqual([]);
      runtimeDown.now = false;
      const second = createContainers({
        instanceLabel: "instance-a",
        runtime,
        store,
      });
      await second.recover(() => true);
      await second.recover(() => true);

      expect(events(writes.slice(recovery))).toEqual([
        ["sandbox.destroyed", left.id],
      ]);
      const claims = writes
        .slice(recovery)
        .filter((write) => write.putContainers !== undefined);
      expect(claims.map((write) => write.putContainers?.[0]?.status)).toEqual([
        "removing",
        "removing",
      ]);
      expect(claims.every((write) => write.events === undefined)).toBe(true);
      await second.shutdown();
    });

    it("carries sandbox.destroyed in the delete, and none when another Containers deleted the row first", async () => {
      const { store, writes } = gatedStore({ transactional: true });
      const runtime = createFakeContainerRuntime();
      const first = createContainers({
        instanceLabel: "instance-a",
        runtime,
        store,
      });
      const second = createContainers({
        instanceLabel: "instance-a",
        runtime,
        store,
      });
      const c = await first.start(CONTAINER_SPEC);
      await c.close();
      const removal = writes.length;

      await Promise.all([first.remove(c.id), second.remove(c.id)]);

      expect(events(writes.slice(removal))).toEqual([
        ["sandbox.destroyed", c.id],
      ]);
      expect(
        writes
          .slice(removal)
          .filter((write) => write.deleteContainers !== undefined)
      ).toHaveLength(1);
    });
  });
});
