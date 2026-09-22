import { describe, expect, it } from "vitest";
import {
  CONTAINER_ID_LABEL,
  CONTAINER_INSTANCE_LABEL,
} from "../container/constants";
import type { ContainerSandboxConstraints } from "../container/constraints";
import { createContainers } from "../container/containers";
import { createMicrosandboxRuntime } from "../container/microsandbox-runtime";
import { createMemoryContainerStore } from "../container/store";

const SPEC: ContainerSandboxConstraints = {
  format: "foundry.sandbox.container/1",
  image: "docker.io/library/debian:trixie-slim",
  network: "disabled",
  ports: [3000],
};

describe("real MicroSandbox containers registry", () => {
  it("starts, restarts under open handles, closes, and sweeps orphans", async () => {
    const runtime = createMicrosandboxRuntime();
    if (!(await runtime.isInstalled())) {
      throw new Error(
        "Install the MicroSandbox runtime before running test:integration"
      );
    }
    const instanceLabel = `itest-${crypto.randomUUID()}`;
    const store = createMemoryContainerStore();
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

    // An orphan: a VM with our labels left by a process that died before
    // closing it, whose row is gone. The next boot's sweep removes it.
    const crashed = createContainers({
      instanceLabel,
      runtime,
      store: createMemoryContainerStore(),
    });
    const orphan = await crashed.start(SPEC);
    const nextBoot = createContainers({
      instanceLabel,
      runtime,
      store: createMemoryContainerStore(),
    });
    expect(await nextBoot.sweep()).toEqual([`${orphan.id}-1`]);
    expect(
      (await inventory()).filter(
        (r) => r.labels[CONTAINER_ID_LABEL] === orphan.id
      )
    ).toEqual([]);
  }, 120_000);
});
