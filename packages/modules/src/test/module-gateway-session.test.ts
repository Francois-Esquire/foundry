import { contentIdSchema } from "@foundry/artifacts";
import { describe, expect, it, vi } from "vitest";
import {
  createDisabledInstallation,
  defineModule,
  defineModuleVersion,
  installationIdSchema,
  moduleIdSchema,
  runtimeInstanceIdSchema,
} from "../domain";
import { createModuleGateway } from "../gateway/module-gateway";
import type {
  ModuleGatewayRuntimeDispatcher,
  ModuleRuntimeIdentity,
} from "../gateway/types";
import { ModuleGatewayError } from "../gateway/types";
import { InMemoryModuleStore } from "../store/memory";
import { FakeTransport } from "./helpers/fake-transport";
import { moduleFixture } from "./helpers/module-fixture";

const manifest = {
  capabilities: [],
  compatibility: { gateway: "1", runtime: "bun@1" },
  format: "foundry.module/1",
  program: { entry: "outputs/program/server.js" },
  views: { home: { path: "/" } },
} as const;

describe("Module Gateway sessions", () => {
  it("binds one ready transport to the host-created Runtime Instance", async () => {
    const fixture = await createFixture();
    const gateway = createModuleGateway({ store: fixture.store });
    const transport = new FakeTransport();
    transport.push({ kind: "ready", mode: "runtime", protocol: 1 });

    const session = await gateway.connect({
      capabilities: fixture.capabilities,
      runtime: fixture.runtime,
      transport,
    });
    expect(transport.send).toHaveBeenCalledWith({
      binding: {
        generation: 0,
        installationId: "installation-1",
        moduleId: "module-1",
        releaseId: fixture.runtime.contentId,
        runtimeInstanceId: "runtime-1",
      },
      kind: "hello",
      mode: "runtime",
      protocol: 1,
    });
    await expect(
      gateway.connect({
        capabilities: fixture.capabilities,
        runtime: fixture.runtime,
        transport: new FakeTransport(),
      })
    ).rejects.toMatchObject({ code: "duplicate-request" });

    await session.close("test complete");
    await expect(session.closed).resolves.toEqual({
      code: "requested",
      reason: "test complete",
    });
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("rejects stale identity and an incompatible handshake", async () => {
    const fixture = await createFixture();
    const gateway = createModuleGateway({ store: fixture.store });
    const staleTransport = new FakeTransport();

    await expect(
      gateway.connect({
        capabilities: fixture.capabilities,
        runtime: { ...fixture.runtime, generation: 1 },
        transport: staleTransport,
      })
    ).rejects.toMatchObject({ code: "stale-runtime" });
    await expect(
      gateway.connect({
        capabilities: fixture.capabilities,
        runtime: {
          ...fixture.runtime,
          contentId: contentIdSchema.parse("unselected-content"),
        },
        transport: staleTransport,
      })
    ).rejects.toMatchObject({ code: "stale-runtime" });
    await expect(
      gateway.connect({
        capabilities: fixture.capabilities,
        runtime: {
          ...fixture.runtime,
          installationId: installationIdSchema.parse("missing"),
        },
        transport: staleTransport,
      })
    ).rejects.toMatchObject({ code: "stale-runtime" });
    expect(staleTransport.close).not.toHaveBeenCalled();

    const incompatible = new FakeTransport();
    incompatible.push({ kind: "ready", mode: "runtime", protocol: 2 });
    await expect(
      gateway.connect({
        capabilities: fixture.capabilities,
        runtime: fixture.runtime,
        transport: incompatible,
      })
    ).rejects.toBeInstanceOf(ModuleGatewayError);
    expect(incompatible.close).toHaveBeenCalledWith(
      "Gateway handshake rejected"
    );
  });

  it("settles when the Program requests shutdown", async () => {
    const fixture = await createFixture();
    const gateway = createModuleGateway({ store: fixture.store });
    const transport = new FakeTransport();
    transport.push({ kind: "ready", mode: "runtime", protocol: 1 });
    const session = await gateway.connect({
      capabilities: fixture.capabilities,
      runtime: fixture.runtime,
      transport,
    });

    transport.push({ kind: "shutdown", reason: "Program stopped" });
    await expect(session.closed).resolves.toEqual({
      code: "requested",
      reason: "Program stopped",
    });
  });

  it("reserves a Runtime Instance while its handshake is in flight", async () => {
    const fixture = await createFixture();
    const gateway = createModuleGateway({ store: fixture.store });
    const firstTransport = new FakeTransport();
    const pending = gateway.connect({
      capabilities: fixture.capabilities,
      runtime: fixture.runtime,
      transport: firstTransport,
    });
    await Promise.resolve();
    await Promise.resolve();

    await expect(
      gateway.connect({
        capabilities: fixture.capabilities,
        runtime: fixture.runtime,
        transport: new FakeTransport(),
      })
    ).rejects.toMatchObject({ code: "duplicate-request" });

    firstTransport.push({ kind: "ready", mode: "runtime", protocol: 1 });
    const session = await pending;
    await session.close("test complete");
  });

  it("keeps development catalog traffic separate from runtime invocation traffic", async () => {
    const fixture = await createFixture();
    const gateway = createModuleGateway({ store: fixture.store });
    const transport = new FakeTransport();
    transport.push({ kind: "ready", mode: "development", protocol: 1 });
    const session = await gateway.connectDevelopment({
      catalog: { capabilities: [], generation: 3 },
      developmentId: "project-1/environment-1",
      transport,
    });

    expect(transport.send).toHaveBeenNthCalledWith(1, {
      binding: { developmentId: "project-1/environment-1" },
      kind: "hello",
      mode: "development",
      protocol: 1,
    });
    expect(transport.send).toHaveBeenNthCalledWith(2, {
      catalog: { capabilities: [], generation: 3 },
      kind: "catalog.snapshot",
    });
    await session.publishCatalogChange("catalog-4");
    expect(transport.send).toHaveBeenNthCalledWith(3, {
      kind: "catalog.changed",
      revision: "catalog-4",
    });
    transport.push({
      alias: "files",
      id: "request-1",
      input: {},
      kind: "invoke",
      mode: "unary",
    });
    await expect(session.closed).resolves.toMatchObject({
      code: "protocol-error",
    });
  });

  it("frames unary and server-stream results through one bounded dispatcher", async () => {
    const fixture = await createFixture();
    const dispatch = vi.fn<ModuleGatewayRuntimeDispatcher["dispatch"]>(
      ({ request }) => {
        if (request.mode === "unary") {
          return Promise.resolve({
            mode: "unary" as const,
            output: { ok: true },
          });
        }
        return Promise.resolve({
          events: events(["first", "second"]),
          mode: "stream" as const,
        });
      }
    );
    const dispatcher: ModuleGatewayRuntimeDispatcher = {
      dispatch,
      revoke: vi.fn(),
    };
    const gateway = createModuleGateway({
      runtimeDispatcher: dispatcher,
      store: fixture.store,
    });
    const transport = new FakeTransport();
    transport.push({ kind: "ready", mode: "runtime", protocol: 1 });
    await gateway.connect({
      capabilities: fixture.capabilities,
      runtime: fixture.runtime,
      transport,
    });

    transport.push({
      alias: "notification",
      id: "unary-1",
      input: { title: "Hi" },
      kind: "invoke",
      mode: "unary",
    });
    transport.push({
      alias: "agent",
      id: "stream-1",
      input: {},
      kind: "invoke",
      mode: "stream",
    });

    await vi.waitFor(() => {
      expect(transport.send).toHaveBeenCalledWith({
        id: "unary-1",
        kind: "result",
        output: { ok: true },
      });
      expect(transport.send).toHaveBeenCalledWith({
        event: "first",
        id: "stream-1",
        kind: "next",
      });
      expect(transport.send).toHaveBeenCalledWith({
        event: "second",
        id: "stream-1",
        kind: "next",
      });
      expect(transport.send).toHaveBeenCalledWith({
        id: "stream-1",
        kind: "complete",
      });
    });
    expect(dispatch.mock.calls[0]?.[0].capabilities).toBe(fixture.capabilities);
  });

  it("rejects duplicate IDs, bounds concurrent work, and cancels on disconnect", async () => {
    const fixture = await createFixture();
    const pending = deferred<{
      readonly mode: "unary";
      readonly output: unknown;
    }>();
    let signal: AbortSignal | undefined;
    const dispatch = vi.fn<ModuleGatewayRuntimeDispatcher["dispatch"]>(
      (input) => {
        ({ signal } = input);
        return pending.promise;
      }
    );
    const dispatcher: ModuleGatewayRuntimeDispatcher = {
      dispatch,
      revoke: vi.fn(),
    };
    const gateway = createModuleGateway({
      maximumInFlight: 1,
      runtimeDispatcher: dispatcher,
      store: fixture.store,
    });
    const transport = new FakeTransport();
    transport.push({ kind: "ready", mode: "runtime", protocol: 1 });
    await gateway.connect({
      capabilities: fixture.capabilities,
      runtime: fixture.runtime,
      transport,
    });
    const request = {
      alias: "agent",
      id: "request-1",
      input: {},
      kind: "invoke" as const,
      mode: "unary" as const,
    };
    transport.push(request);
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledOnce();
    });
    transport.push(request);
    transport.push({ ...request, id: "request-2" });
    await vi.waitFor(() => {
      expect(transport.send).toHaveBeenCalledWith({
        code: "duplicate-request",
        id: "request-1",
        kind: "failure",
        message: "Gateway request ID has already been used",
      });
      expect(transport.send).toHaveBeenCalledWith({
        code: "capacity-exceeded",
        id: "request-2",
        kind: "failure",
        message: "Gateway has reached its in-flight request limit",
      });
    });
    transport.disconnect();
    await vi.waitFor(() => {
      expect(signal?.aborted).toBe(true);
    });
    pending.resolve({ mode: "unary", output: {} });
  });

  it("normalizes provider failures without exposing provider details", async () => {
    const fixture = await createFixture();
    const dispatcher: ModuleGatewayRuntimeDispatcher = {
      dispatch: () => Promise.reject(new Error("credential: private-value")),
      revoke: vi.fn(),
    };
    const gateway = createModuleGateway({
      runtimeDispatcher: dispatcher,
      store: fixture.store,
    });
    const transport = new FakeTransport();
    transport.push({ kind: "ready", mode: "runtime", protocol: 1 });
    const session = await gateway.connect({
      capabilities: fixture.capabilities,
      runtime: fixture.runtime,
      transport,
    });

    transport.push({
      alias: "fetch",
      id: "failure-1",
      input: {},
      kind: "invoke",
      mode: "unary",
    });
    await vi.waitFor(() => {
      expect(transport.send).toHaveBeenCalledWith({
        code: "provider-failure",
        id: "failure-1",
        kind: "failure",
        message: "Gateway provider failed",
      });
    });
    await session.close("test complete");
  });

  it("does not admit a frame read after closing starts", async () => {
    const fixture = await createFixture();
    const dispatch = vi.fn(() =>
      Promise.resolve({ mode: "unary" as const, output: {} })
    );
    const gateway = createModuleGateway({
      runtimeDispatcher: { dispatch, revoke: vi.fn() },
      store: fixture.store,
    });
    const transport = new FakeTransport();
    transport.push({ kind: "ready", mode: "runtime", protocol: 1 });
    const session = await gateway.connect({
      capabilities: fixture.capabilities,
      runtime: fixture.runtime,
      transport,
    });
    transport.push({
      alias: "files",
      id: "queued",
      input: {},
      kind: "invoke",
      mode: "unary",
    });
    await session.close("closing before queued frame resumes");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("handles terminal transport failure when closing an active stream", async () => {
    const fixture = await createFixture();
    const entered = Promise.withResolvers<void>();
    const finished = vi.fn();
    const gateway = createModuleGateway({
      runtimeDispatcher: {
        dispatch: ({ signal }) =>
          Promise.resolve({
            events: (async function* () {
              try {
                const aborted = new Promise<void>((resolve) =>
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  })
                );
                entered.resolve();
                await aborted;
                yield "late";
              } finally {
                finished();
              }
            })(),
            mode: "stream",
          }),
        revoke: vi.fn(),
      },
      store: fixture.store,
    });
    const transport = new FakeTransport();
    transport.push({ kind: "ready", mode: "runtime", protocol: 1 });
    const session = await gateway.connect({
      capabilities: fixture.capabilities,
      runtime: fixture.runtime,
      transport,
    });
    transport.push({
      alias: "files",
      id: "closing",
      input: {},
      kind: "invoke",
      mode: "stream",
    });
    await entered.promise;
    await session.close("active stream shutdown");
    await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("waits for stream cleanup before settling every close caller", async () => {
    const fixture = await createFixture();
    const entered = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const gateway = createModuleGateway({
      runtimeDispatcher: {
        dispatch: ({ signal }) =>
          Promise.resolve({
            events: (async function* () {
              try {
                const aborted = new Promise<void>((resolve) =>
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  })
                );
                entered.resolve();
                await aborted;
                yield "late";
              } finally {
                cleaning.resolve();
                await release.promise;
              }
            })(),
            mode: "stream",
          }),
        revoke: vi.fn(),
      },
      store: fixture.store,
    });
    const transport = new FakeTransport();
    transport.push({ kind: "ready", mode: "runtime", protocol: 1 });
    const session = await gateway.connect({ ...fixture, transport });
    transport.push({
      alias: "files",
      id: "cleanup",
      input: {},
      kind: "invoke",
      mode: "stream",
    });
    await entered.promise;
    const firstDone = vi.fn();
    const secondDone = vi.fn();
    const closed = vi.fn();
    const first = session.close("first").then(firstDone);
    const second = session.close("second").then(secondDone);
    session.closed.then(closed);
    await cleaning.promise;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(firstDone).not.toHaveBeenCalled();
      expect(secondDone).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
    await expect(session.closed).resolves.toEqual({
      code: "requested",
      reason: "first",
    });
    expect(transport.send.mock.calls).toHaveLength(1);
  });

  it.each(["resolve", "reject"] as const)(
    "reports abandoned work and observes late stream cleanup that will %s",
    async (outcome) => {
      const fixture = await createFixture();
      const pending = Promise.withResolvers<{
        readonly mode: "stream";
        readonly events: AsyncIterable<unknown>;
      }>();
      const dispatch = vi.fn(() => pending.promise);
      const gateway = createModuleGateway({
        cancellationGraceMs: 1,
        runtimeDispatcher: { dispatch, revoke: vi.fn() },
        store: fixture.store,
      });
      const transport = new FakeTransport();
      transport.push({ kind: "ready", mode: "runtime", protocol: 1 });
      const session = await gateway.connect({ ...fixture, transport });
      transport.push({
        alias: "files",
        id: "late",
        input: {},
        kind: "invoke",
        mode: "stream",
      });
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      await session.close("bounded close");
      await expect(session.closed).resolves.toEqual({
        abandoned: ["late"],
        code: "requested",
        reason: "bounded close",
      });
      const returned = vi.fn(() =>
        outcome === "resolve"
          ? Promise.resolve({ done: true as const, value: undefined })
          : Promise.reject(new Error("late cleanup failed"))
      );
      const next = vi.fn(() =>
        Promise.resolve({ done: true as const, value: undefined })
      );
      pending.resolve({
        events: { [Symbol.asyncIterator]: () => ({ next, return: returned }) },
        mode: "stream",
      });
      await vi.waitFor(() => expect(returned).toHaveBeenCalledOnce());
      expect(next).not.toHaveBeenCalled();
      expect(transport.send.mock.calls).toHaveLength(1);
    }
  );

  it("shares transport cleanup failure between concurrent close callers", async () => {
    const fixture = await createFixture();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const transport = new FakeTransport();
    transport.close.mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });
    transport.push({ kind: "ready", mode: "runtime", protocol: 1 });
    const session = await createModuleGateway({ store: fixture.store }).connect(
      { ...fixture, transport }
    );
    const first = session.close("first");
    await entered.promise;
    const second = session.close("second");
    expect(second).toBe(first);
    const firstFailure = expect(first).rejects.toThrow(
      "transport cleanup failed"
    );
    const secondFailure = expect(second).rejects.toThrow(
      "transport cleanup failed"
    );
    gate.reject(new Error("transport cleanup failed"));
    await Promise.all([firstFailure, secondFailure]);
    await expect(session.closed).resolves.toEqual({
      code: "requested",
      reason: "first",
    });
  });

  it("observes a rejected capacity reply during shutdown", async () => {
    const fixture = await createFixture();
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<{
      readonly mode: "unary";
      readonly output: unknown;
    }>();
    const transport = new FakeTransport();
    transport.push({ kind: "ready", mode: "runtime", protocol: 1 });
    const session = await createModuleGateway({
      maximumInFlight: 1,
      runtimeDispatcher: {
        dispatch: () => {
          entered.resolve();
          return pending.promise;
        },
        revoke: vi.fn(),
      },
      store: fixture.store,
    }).connect({ ...fixture, transport });
    transport.push({
      alias: "files",
      id: "held",
      input: {},
      kind: "invoke",
      mode: "unary",
    });
    await entered.promise;
    transport.send.mockRejectedValueOnce(new Error("reply transport failed"));
    transport.push({
      alias: "files",
      id: "over-capacity",
      input: {},
      kind: "invoke",
      mode: "unary",
    });
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
    pending.resolve({ mode: "unary", output: {} });
    await expect(session.closed).resolves.toEqual({
      code: "transport-closed",
      reason: "Gateway transport failed",
    });
  });

  it("closes after two missed heartbeat responses", async () => {
    const fixture = await createFixture();
    const gateway = createModuleGateway({
      heartbeatIntervalMs: 5,
      store: fixture.store,
    });
    const transport = new FakeTransport();
    transport.push({ kind: "ready", mode: "runtime", protocol: 1 });
    const session = await gateway.connect({
      capabilities: fixture.capabilities,
      runtime: fixture.runtime,
      transport,
    });

    await expect(session.closed).resolves.toEqual({
      code: "protocol-error",
      reason: "Gateway heartbeat timed out",
    });
    expect(transport.send).toHaveBeenCalledWith({
      kind: "heartbeat",
      sequence: 1,
    });
    expect(transport.send).toHaveBeenCalledWith({
      kind: "heartbeat",
      sequence: 2,
    });
  });
});

async function createFixture() {
  const { artifact, content } = await moduleFixture();
  const module = defineModule({
    artifact,
    id: moduleIdSchema.parse("module-1"),
  });
  const version = defineModuleVersion({
    artifact,
    content,
    manifest,
    module,
  });
  const store = new InMemoryModuleStore();
  await store.registerModule({ module });
  const installation = createDisabledInstallation({
    id: installationIdSchema.parse("installation-1"),
    now: new Date("2026-08-09T00:00:00.000Z"),
    version,
  });
  await store.createInstallation({
    id: installation.id,
    now: installation.createdAt,
    version,
  });
  const runtime: ModuleRuntimeIdentity = Object.freeze({
    contentId: version.contentId,
    generation: installation.generation,
    installationId: installation.id,
    runtimeInstanceId: runtimeInstanceIdSchema.parse("runtime-1"),
  });
  return { capabilities: version.manifest.capabilities, runtime, store };
}

async function* events(values: readonly unknown[]): AsyncIterable<unknown> {
  for (const value of values) {
    yield await Promise.resolve(value);
  }
}

function deferred<Value>() {
  let resolve: ((value: Value | PromiseLike<Value>) => void) | undefined;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (resolve === undefined) {
    throw new Error("Deferred did not initialize");
  }
  return { promise, resolve };
}
