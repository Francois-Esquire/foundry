import { MessageChannel, type MessagePort } from "node:worker_threads";
import { InMemoryArtifactStore } from "@foundry/artifacts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import { RPCHandler } from "@orpc/server/message-port";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorksClient } from "~/app/api/client";
import { createModuleLibrary } from "~/main/modules/library";
import { router } from "~/main/router/root";
import type { Vault } from "~/main/vault/vault";
import type { VaultStatus } from "~/shared/vault";
import { fakeClient, openFakeVault } from "../helpers/fake-api";

const ports: MessagePort[] = [];

afterEach(() => {
  for (const port of ports.splice(0)) {
    port.close();
  }
});

function portClient(vault: Vault): WorksClient {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  new RPCHandler(router).upgrade(port2, {
    context: {
      modules: createModuleLibrary(new InMemoryArtifactStore()),
      vault,
    },
  });
  port1.start();
  port2.start();
  return createORPCClient(new RPCLink({ port: port1 }));
}

function trackSubscriptions(vault: Vault) {
  const subscribe = vault.onChange.bind(vault);
  const unsubscribes: ReturnType<typeof vi.fn>[] = [];
  vi.spyOn(vault, "onChange").mockImplementation((listener) => {
    const unsubscribe = vi.fn(subscribe(listener));
    unsubscribes.push(unsubscribe);
    return unsubscribe;
  });
  return unsubscribes;
}

async function nextStatus(
  stream: AsyncIterator<VaultStatus, unknown>
): Promise<VaultStatus> {
  const next = await stream.next();
  if (next.done) {
    throw new Error("Vault stream ended before the expected status");
  }
  return next.value;
}

describe("vault watch", () => {
  it("starts with current status and preserves queued change order", async () => {
    const vault = await openFakeVault({ env: { FAL_KEY: "environment-key" } });
    const client = fakeClient(vault);
    const stream = await client.vault.watch();
    try {
      expect((await stream.next()).value).toEqual(await client.vault.status());
      await Promise.all([
        client.vault.set({ key: "apiKey", owner: "fal", value: "private-key" }),
        client.vault.clear({ key: "apiKey", owner: "fal" }),
      ]);
      const saved = await nextStatus(stream);
      const cleared = await nextStatus(stream);
      expect(saved.fields.fal.apiKey?.source).toBe("store");
      expect(cleared.fields.fal.apiKey?.source).toBe("env");
      expect(JSON.stringify([saved, cleared])).not.toContain("private-key");
      expect(JSON.stringify([saved, cleared])).not.toContain("environment-key");
    } finally {
      await stream.return();
    }
  });

  it("releases a subscription returned before its first read", async () => {
    const vault = await openFakeVault();
    const unsubscribes = trackSubscriptions(vault);
    const stream = await fakeClient(vault).vault.watch();
    await stream.return();
    expect(unsubscribes).toHaveLength(1);
    expect(unsubscribes[0]).toHaveBeenCalled();
    expect((await stream.next()).done).toBe(true);
  });

  it("aborts a waiting read and immediately releases the subscription", async () => {
    const vault = await openFakeVault();
    const unsubscribes = trackSubscriptions(vault);
    const controller = new AbortController();
    const stream = await fakeClient(vault).vault.watch(undefined, {
      signal: controller.signal,
    });
    await stream.next();
    const waiting = expect(stream.next()).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await waiting;
    expect(unsubscribes[0]).toHaveBeenCalled();
  });

  it("does not subscribe when the request is already aborted", async () => {
    const vault = await openFakeVault();
    const subscribe = vi.spyOn(vault, "onChange");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      fakeClient(vault).vault.watch(undefined, { signal: controller.signal })
    ).rejects.toThrow();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("releases an idle subscriber on abort without waiting for another read", async () => {
    const vault = await openFakeVault();
    const unsubscribes = trackSubscriptions(vault);
    const controller = new AbortController();
    const stream = await fakeClient(vault).vault.watch(undefined, {
      signal: controller.signal,
    });
    await stream.next();
    controller.abort();
    expect(unsubscribes[0]).toHaveBeenCalled();
    await stream.return();
  });

  it("return settles a pending read and releases its subscription", async () => {
    const vault = await openFakeVault();
    const unsubscribes = trackSubscriptions(vault);
    const stream = await fakeClient(vault).vault.watch();
    await stream.next();
    const pending = stream.next();
    await stream.return();
    expect((await pending).done).toBe(true);
    expect(unsubscribes[0]).toHaveBeenCalled();
  });

  it("streams to independent message-port clients and reconnects with fresh status", async () => {
    const vault = await openFakeVault();
    const first = portClient(vault);
    const second = portClient(vault);
    const stream = await first.vault.watch();
    const other = await second.vault.watch();
    try {
      expect((await stream.next()).value).toEqual(vault.status());
      await other.next();
      await second.vault.set({ key: "apiKey", owner: "fal", value: "secret" });
      expect((await nextStatus(stream)).fields.fal.apiKey?.source).toBe(
        "store"
      );
      expect((await nextStatus(other)).fields.fal.apiKey?.source).toBe("store");
      await stream.return();
      await second.vault.clear({ key: "apiKey", owner: "fal" });
      expect((await nextStatus(other)).fields.fal.apiKey?.source).toBe("none");
      const reconnected = await first.vault.watch();
      try {
        expect((await reconnected.next()).value).toEqual(vault.status());
      } finally {
        await reconnected.return();
      }
    } finally {
      await stream.return();
      await other.return();
    }
  });

  it("releases main-process subscriptions when the message port closes", async () => {
    const vault = await openFakeVault();
    const unsubscribes = trackSubscriptions(vault);
    const client = portClient(vault);
    const stream = await client.vault.watch();
    await stream.next();
    ports[0]?.close();
    await vi.waitFor(() => {
      expect(unsubscribes[0]).toHaveBeenCalled();
    });
  });
});
