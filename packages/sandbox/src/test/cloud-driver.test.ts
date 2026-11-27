import {
  containerSpecSchema,
  createContainers,
  isAbsoluteGuestPath,
  SandboxError,
} from "@foundry/sandbox";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { createCloudFakeDriver } from "@foundry/sandbox/testing";
import { describe, expect, it, vi } from "vitest";

describe("cloud-native driver portability", () => {
  it("supports stateless reconnection across fresh Containers instances without recreating", async () => {
    const store = new MemoryContainerStore();
    const driver = createCloudFakeDriver();

    const workerA = createContainers({
      driver,
      holder: "worker-a",
      instanceLabel: "cloud-prod",
      store,
    });
    const first = await workerA.start({
      expose: [{ access: "private", port: 3000, protocol: "https" }],
      image: "ghcr.io/foundry/agent:latest",
      lifetime: {
        idleTimeoutMs: 300_000,
        ttlMs: 3_600_000,
        whenReleased: "keep",
      },
      network: "internet",
      secrets: [{ hosts: ["api.anthropic.com"], name: "ANTHROPIC_API_KEY" }],
    });

    expect(first.row.nativeId).toBe("sbx-1");
    expect(first.shell).toBeUndefined();
    expect(first.storage).toBeUndefined();
    expect(first.processes?.spawn).toBeUndefined();

    await first.files.writeFile("hello.txt", "persisted in cloud");
    await first.close();

    expect(driver.handles).toHaveLength(1);
    expect(driver.handles[0]?.removed).toBe(false);
    expect(driver.handles[0]?.disconnected).toBe(true);
    expect((await store.get(first.id))?.status).toBe("running");

    const workerB = createContainers({
      driver,
      holder: "worker-b",
      instanceLabel: "cloud-prod",
      store,
    });
    const reconnected = await workerB.open(first.id);
    expect(driver.handles).toHaveLength(1);
    expect(reconnected.row.nativeId).toBe("sbx-1");
    expect(
      new TextDecoder().decode(await reconnected.files.readFile("hello.txt"))
    ).toBe("persisted in cloud");

    const endpoint = await reconnected.ports?.endpoint(3000);
    expect(endpoint).toEqual({
      access: "private",
      headers: { authorization: "Bearer token-sbx-1" },
      protocol: "https",
      url: "https://3000-sbx-1.cloud.sandbox.test",
    });
    expect(await reconnected.ports?.hostPort(3000)).toBeUndefined();

    await reconnected.close();
    await workerB.stop(first.id);
    await workerB.remove(first.id);
    expect(driver.handles[0]?.removed).toBe(true);
  });

  it("supports pause, resume, status filtering, and HTTP service readiness via Web fetch", async () => {
    const store = new MemoryContainerStore();
    const driver = createCloudFakeDriver();
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response("ok", { status: 200 }))
    );

    const containers = createContainers({
      driver,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      holder: "worker-1",
      instanceLabel: "cloud-http",
      store,
    });

    const container = await containers.start({
      expose: [{ access: "private", port: 8080, protocol: "https" }],
      image: "ghcr.io/foundry/web:latest",
      lifetime: { ttlMs: 600_000, whenReleased: "keep" },
      network: {
        destinations: [{ host: "api.openai.com", ports: [443] }],
        mode: "allowlist",
      },
    });

    const service = await container.services?.start({
      argv: ["bun", "server.ts"],
      id: "web",
      readiness: {
        intervalMs: 10,
        kind: "http",
        path: "/healthz",
        port: 8080,
        timeoutMs: 1000,
      },
    });
    expect(service?.status).toBe("ready");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://8080-sbx-1.cloud.sandbox.test/healthz"),
      expect.objectContaining({
        headers: { authorization: "Bearer token-sbx-1" },
        method: "GET",
      })
    );

    await containers.pause(container.id);
    expect(await containers.list({ status: "paused" })).toHaveLength(1);
    expect(await containers.list({ status: "running" })).toHaveLength(0);
    expect(await containers.list({ holder: "worker-1" })).toHaveLength(1);
    expect(await containers.list({ holder: "other" })).toHaveLength(0);

    const resumed = await containers.resume(container.id);
    expect(resumed.row.status).toBe("running");
    expect(driver.handles).toHaveLength(1);

    await resumed.close();
    await containers.stop(container.id);
    await containers.remove(container.id);
  });

  it("fails closed when a spec requests capabilities the cloud driver does not support", async () => {
    const driver = createCloudFakeDriver();
    const containers = createContainers({
      driver,
      instanceLabel: "cloud-cap",
      store: new MemoryContainerStore(),
    });

    await expect(
      containers.start({
        image: "ghcr.io/foundry/agent:latest",
        mounts: [
          {
            access: "read-write",
            id: "workspace",
            source: { kind: "host-directory", path: "/tmp/local-project" },
            target: "/workspace",
          },
        ],
      })
    ).rejects.toMatchObject({ code: "unsupported", name: SandboxError.name });

    await expect(
      containers.start({
        image: "ghcr.io/foundry/agent:latest",
        network: "open",
      })
    ).rejects.toMatchObject({ code: "unsupported", name: SandboxError.name });

    await expect(
      containers.start({
        expose: [{ access: "loopback", port: 3000 }],
        image: "ghcr.io/foundry/agent:latest",
      })
    ).rejects.toMatchObject({ code: "unsupported", name: SandboxError.name });

    expect(driver.handles).toHaveLength(0);
  });

  it("accepts OS-agnostic absolute paths including Windows drive paths", () => {
    expect(isAbsoluteGuestPath("/workspace/src")).toBe(true);
    expect(isAbsoluteGuestPath("C:\\workspace\\src")).toBe(true);
    expect(isAbsoluteGuestPath("C:/workspace/src")).toBe(true);
    expect(isAbsoluteGuestPath("C:\\workspace\\..\\escape")).toBe(false);
    expect(isAbsoluteGuestPath("relative/path")).toBe(false);

    const parsed = containerSpecSchema.parse({
      image: "mcr.microsoft.com/windows/nanoserver:ltsc2022",
      workdir: "C:\\workspace",
    });
    expect(parsed.workdir).toBe("C:\\workspace");
  });
});
