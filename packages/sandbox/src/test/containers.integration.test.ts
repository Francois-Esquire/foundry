import { describe, expect, it } from "vitest";
import type { ContainerSandboxConstraints } from "../container/constraints";
import { createContainers } from "../container/containers";
import {
  CONTAINER_ID_LABEL,
  CONTAINER_INSTANCE_LABEL,
} from "../container/defaults";
import { createMicrosandboxRuntime } from "../node/microsandbox";
import { MemoryContainerStore } from "../store/memory";

const SPEC: ContainerSandboxConstraints = {
  format: "foundry.sandbox.container/1",
  image: "docker.io/library/debian:trixie-slim",
  network: "disabled",
  ports: [3000],
};

describe("real MicroSandbox Containers", () => {
  it("starts, restarts under open handles, closes, and sweeps orphans", async () => {
    const runtime = createMicrosandboxRuntime();
    if (!(await runtime.isInstalled())) {
      throw new Error(
        "Install the MicroSandbox runtime before running test:integration"
      );
    }
    const instanceLabel = `itest-${crypto.randomUUID()}`;
    const store = new MemoryContainerStore();
    const containers = createContainers({ instanceLabel, runtime, store });
    const inventory = async () =>
      (
        await runtime.listResources({
          labels: { [CONTAINER_INSTANCE_LABEL]: instanceLabel },
        })
      ).resources;

    const a = await containers.start(SPEC);
    const b = await containers.open(a.id);
    try {
      expect((await a.commands.exec(["echo", "one"])).stdout.trim()).toBe(
        "one"
      );
      expect(await a.ports.hostPort(5173)).toBe(undefined);
      expect((await inventory()).map((r) => r.name)).toEqual([`${a.id}-1`]);

      await containers.restart(a.id, { ...SPEC, ports: [3000, 5173] });

      expect((await store.get(a.id))?.status).toBe("running");
      expect((await inventory()).map((r) => r.name)).toEqual([`${a.id}-2`]);
      expect((await b.commands.exec(["echo", "two"])).stdout.trim()).toBe(
        "two"
      );
      expect(await b.ports.hostPort(5173)).toBeDefined();
    } finally {
      await a.close();
      await b.close();
    }
    expect((await store.get(a.id))?.status).toBe("stopped");
    expect(await inventory()).toEqual([]);

    await containers.shutdown();

    const durable = new MemoryContainerStore();
    const crashed = createContainers({
      instanceLabel,
      runtime,
      store: durable,
    });
    const orphan = await crashed.start(SPEC);
    await durable.commit({ deleteContainers: [orphan.id] });
    const nextBoot = createContainers({
      instanceLabel,
      runtime,
      store: durable,
    });
    expect(await nextBoot.sweep()).toEqual([`${orphan.id}-1`]);
    expect(
      (await inventory()).filter(
        (r) => r.labels[CONTAINER_ID_LABEL] === orphan.id
      )
    ).toEqual([]);
  }, 120_000);
});
