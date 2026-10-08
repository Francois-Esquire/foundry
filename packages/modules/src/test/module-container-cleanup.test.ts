import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { describe, expect, it, vi } from "vitest";

import { withConfirmedModuleContainerCleanup } from "../platform/container-cleanup";

const spec = {
  format: "foundry.sandbox.container/1",
  network: "disabled",
} as const;

function fixture() {
  const runtime = createFakeContainerRuntime();
  const containers = withConfirmedModuleContainerCleanup(
    createContainers({
      instanceLabel: "module-test",
      runtime,
      store: createMemoryContainerStore(),
    }),
    runtime
  );
  return { containers, runtime };
}

describe("Module container cleanup", () => {
  it("retries failed native cleanup after the registry close became a no-op", async () => {
    const { runtime, containers } = fixture();
    const handle = await containers.start(spec);
    const [instance] = runtime.instances;
    if (instance === undefined) {
      throw new Error("Expected container instance");
    }
    vi.spyOn(instance, "remove").mockRejectedValueOnce(
      new Error("native removal failed")
    );
    await expect(handle.close()).rejects.toThrow("native removal failed");
    expect(instance.removed).toBe(false);
    await handle.close();
    expect(instance.removed).toBe(true);
    await containers.remove(handle.id);
    expect(await containers.list()).toEqual([]);
  });

  it("retains cleanup identity after registry deletion swallowed a native failure", async () => {
    const { runtime, containers } = fixture();
    const handle = await containers.start(spec);
    const [instance] = runtime.instances;
    if (instance === undefined) {
      throw new Error("Expected container instance");
    }
    vi.spyOn(instance, "remove").mockRejectedValueOnce(
      new Error("close failed")
    );
    await expect(handle.close()).rejects.toThrow("close failed");
    const stop = vi
      .spyOn(runtime, "stopResource")
      .mockRejectedValue(new Error("still running"));
    await expect(containers.remove(handle.id)).rejects.toThrow("still running");
    expect(await containers.list()).toEqual([]);
    expect(instance.removed).toBe(false);
    stop.mockRestore();
    await containers.remove(handle.id);
    expect(instance.removed).toBe(true);
  });

  it("does not bypass live handle ownership", async () => {
    const { runtime, containers } = fixture();
    const handle = await containers.start(spec);
    const stop = vi.spyOn(runtime, "stopResource");
    await expect(containers.remove(handle.id)).rejects.toThrow("live");
    expect(stop).not.toHaveBeenCalled();
    await handle.close();
    await containers.remove(handle.id);
  });

  it("keeps facet getters live across registry restart", async () => {
    const { runtime, containers } = fixture();
    const handle = await containers.start(spec);
    await handle.files.copyIn({ "/old.txt": "old" });
    await containers.restart(handle.id, spec);
    await handle.files.copyIn({ "/new.txt": "new" });
    expect(runtime.instances).toHaveLength(2);
    expect(await handle.files.readFile("/new.txt")).toEqual(
      new TextEncoder().encode("new")
    );
    await handle.close();
    await containers.remove(handle.id);
  });
});
