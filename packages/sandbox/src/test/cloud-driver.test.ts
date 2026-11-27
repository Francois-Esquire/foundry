import {
  containerSpecSchema,
  createContainers,
  isAbsoluteGuestPath,
  SandboxError,
} from "@foundry/sandbox";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import {
  createCloudFakeDriver,
  createFakeDriver,
} from "@foundry/sandbox/testing";
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
    expect((await reconnected.ports?.endpoint(3000))?.host).toBeUndefined();

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

  it("fails closed when a driver omits capabilities or individual capability fields", async () => {
    const base = createFakeDriver();
    const undeclared = { ...base, capabilities: undefined };
    const empty = { ...base, capabilities: {} };

    for (const driver of [undeclared, empty]) {
      const containers = createContainers({
        driver,
        instanceLabel: "fail-closed",
        store: new MemoryContainerStore(),
      });
      await expect(
        containers.start({ image: "ghcr.io/foundry/agent:latest" })
      ).rejects.toMatchObject({ code: "unsupported", name: SandboxError.name });
      await expect(
        containers.start({
          image: "ghcr.io/foundry/agent:latest",
          network: "open",
        })
      ).rejects.toMatchObject({ code: "unsupported", name: SandboxError.name });
      await expect(
        containers.start({
          expose: [{ port: 3000 }],
          image: "ghcr.io/foundry/agent:latest",
        })
      ).rejects.toMatchObject({ code: "unsupported", name: SandboxError.name });
      await expect(
        containers.start({
          image: "ghcr.io/foundry/agent:latest",
          secrets: [{ hosts: ["api.example.com"], name: "TOKEN" }],
        })
      ).rejects.toMatchObject({ code: "unsupported", name: SandboxError.name });
      await expect(
        containers.start({
          image: "ghcr.io/foundry/agent:latest",
          lifetime: { ttlMs: 60_000 },
        })
      ).rejects.toMatchObject({ code: "unsupported", name: SandboxError.name });
    }
    expect(base.handles).toHaveLength(0);
  });

  it("rejects live pause without a pause implementation and never replaces a paused container on resume", async () => {
    const base = createFakeDriver({ pause: false });
    const fakePauseCap = {
      ...base,
      capabilities: { ...base.capabilities, pause: true },
    };
    const store = new MemoryContainerStore();
    const c1 = createContainers({
      driver: fakePauseCap,
      instanceLabel: "pause-guard",
      store,
    });
    const live = await c1.start({ image: "ghcr.io/foundry/agent:latest" });
    await expect(c1.pause(live.id)).rejects.toMatchObject({
      code: "unsupported",
      name: SandboxError.name,
    });
    expect(base.handles[0]?.disconnected).toBe(false);
    expect((await c1.get(live.id))?.status).toBe("running");
    await live.close();
    await c1.shutdown();

    const noConnect = createFakeDriver({ connect: false, pause: true });
    const store2 = new MemoryContainerStore();
    const c2 = createContainers({
      driver: noConnect,
      instanceLabel: "resume-guard",
      store: store2,
    });
    const paused = await c2.start({
      image: "ghcr.io/foundry/agent:latest",
      lifetime: { whenReleased: "keep" },
    });
    await c2.pause(paused.id);
    await expect(c2.resume(paused.id)).rejects.toMatchObject({
      code: "unsupported",
      name: SandboxError.name,
    });
    expect(noConnect.handles).toHaveLength(1);
    expect(noConnect.handles[0]?.removed).toBe(false);
    expect((await c2.get(paused.id))?.status).toBe("paused");
    await c2.shutdown();
  });

  it("claims holder on reconnect without duplicate started event and replaces on detached restart with changed spec", async () => {
    const store = new MemoryContainerStore();
    const driver = createCloudFakeDriver();
    const workerA = createContainers({
      driver,
      holder: "worker-a",
      instanceLabel: "claim-test",
      store,
    });
    const first = await workerA.start({
      image: "ghcr.io/foundry/agent:v1",
      lifetime: { whenReleased: "keep" },
    });
    await first.close();
    await workerA.shutdown();

    const workerB = createContainers({
      driver,
      holder: "worker-b",
      instanceLabel: "claim-test",
      store,
    });
    const recordedEvents: string[] = [];
    const origTransaction = store.transaction.bind(store);
    store.transaction = (work) =>
      origTransaction(async (view) => {
        const origCommit = view.commit.bind(view);
        return work({
          ...view,
          commit: (write) => {
            for (const event of write.events ?? []) {
              recordedEvents.push(event.type);
            }
            return origCommit(write);
          },
        });
      });
    const reopened = await workerB.open(first.id);
    expect((await workerB.get(first.id))?.holder).toBe("worker-b");
    expect(recordedEvents).not.toContain("sandbox.started");
    await reopened.close();

    await workerB.restart(first.id, {
      image: "ghcr.io/foundry/agent:v2",
      lifetime: { whenReleased: "keep" },
    });
    const replaced = await workerB.open(first.id);
    expect(driver.handles).toHaveLength(2);
    expect(driver.handles[1]?.spec.image).toBe("ghcr.io/foundry/agent:v2");
    await replaced.close();
    await workerB.shutdown();
  });

  it("retries disconnect without removing a retained resource when disconnect fails once", async () => {
    const driver = createCloudFakeDriver();
    const store = new MemoryContainerStore();
    const containers = createContainers({
      driver,
      instanceLabel: "detach-retry",
      store,
    });
    const handle = await containers.start({
      image: "ghcr.io/foundry/agent:latest",
      lifetime: { whenReleased: "keep" },
    });
    const [underlying] = driver.handles;
    expect(underlying).toBeDefined();
    let attempts = 0;
    const origDisconnect = underlying?.disconnect?.bind(underlying);
    if (underlying) {
      underlying.disconnect = async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient detach error");
        }
        await origDisconnect?.();
      };
    }

    await expect(handle.close()).rejects.toThrow("transient detach error");
    await handle.close();
    expect(attempts).toBe(2);
    expect(underlying?.removed).toBe(false);
    expect(underlying?.stopped).toBe(false);
    await containers.shutdown();
  });

  it("rejects cross-origin HTTP readiness paths and redirects without sending endpoint headers off-origin", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    const driver = createCloudFakeDriver();
    const containers = createContainers({
      driver,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      instanceLabel: "http-origin",
      store: new MemoryContainerStore(),
    });
    const container = await containers.start({
      expose: [{ access: "private", port: 3000, protocol: "https" }],
      image: "ghcr.io/foundry/agent:latest",
    });
    try {
      await expect(
        container.services?.start({
          argv: ["bun", "server.ts"],
          id: "web",
          readiness: {
            intervalMs: 10,
            kind: "http",
            path: "https://attacker.example/steal",
            port: 3000,
            timeoutMs: 60,
          },
        })
      ).rejects.toMatchObject({ code: "provider-failed" });
      expect(fetchMock).not.toHaveBeenCalled();

      const svc = await container.services?.start({
        argv: ["bun", "server.ts"],
        id: "web-ok",
        readiness: {
          intervalMs: 10,
          kind: "http",
          path: "/health",
          port: 3000,
          timeoutMs: 200,
        },
      });
      expect(svc?.status).toBe("ready");
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ redirect: "manual" })
      );
      await svc?.terminate();
    } finally {
      await container.close();
      await containers.shutdown();
    }
  });
});
