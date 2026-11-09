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
  ModuleGatewayDispatchResult,
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

  it("closes with streams still running and sends nothing after closing", async () => {
    const fixture = await createFixture();
    const started: string[] = [];
    const dispatcher: ModuleGatewayRuntimeDispatcher = {
      dispatch: ({ request, signal }) =>
        Promise.resolve({
          events: (async function* () {
            started.push(request.id);
            // One stream ends when aborted; the other never notices.
            await new Promise<void>((resolve) => {
              if (request.id === "follows-abort") {
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              }
            });
            yield* [];
          })(),
          mode: "stream" as const,
        }),
      revoke: vi.fn(),
    };
    const gateway = createModuleGateway({
      cancellationGraceMs: 50,
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
    for (const id of ["follows-abort", "ignores-abort"]) {
      transport.push({
        alias: "watch",
        id,
        input: {},
        kind: "invoke",
        mode: "stream",
      });
    }
    await vi.waitFor(() => expect(started).toHaveLength(2));
    const sent = transport.send.mock.calls.length;

    // Resolving means every dispatch has finished or was given up on; an
    // unhandled rejection from a late send would fail this test.
    await session.close("shutdown with active streams");
    await expect(session.closed).resolves.toEqual({
      abandoned: ["ignores-abort"],
      code: "requested",
      reason: "shutdown with active streams",
    });
    expect(transport.send).toHaveBeenCalledTimes(sent);
  });

  it("still answers a cancelled stream while the session is open", async () => {
    const fixture = await createFixture();
    const dispatcher: ModuleGatewayRuntimeDispatcher = {
      dispatch: () =>
        Promise.resolve({
          // Never ends on its own, abort or not.
          events: (async function* () {
            await new Promise<void>(() => undefined);
            yield* [];
          })(),
          mode: "stream" as const,
        }),
      revoke: vi.fn(),
    };
    const gateway = createModuleGateway({
      cancellationGraceMs: 50,
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
      alias: "watch",
      id: "stream-1",
      input: {},
      kind: "invoke",
      mode: "stream",
    });
    transport.push({ id: "stream-1", kind: "cancel" });
    await vi.waitFor(() => {
      expect(transport.send).toHaveBeenCalledWith({
        code: "cancelled",
        id: "stream-1",
        kind: "failure",
        message: "Gateway request was cancelled",
      });
    });
    await session.close("test complete");
  });

  it("settles when the transport fails under an open session", async () => {
    const fixture = await createFixture();
    const gateway = createModuleGateway({
      runtimeDispatcher: {
        dispatch: () => Promise.resolve({ mode: "unary", output: {} }),
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
    transport.send.mockRejectedValue(new Error("Socket failed"));
    transport.push({
      alias: "fetch",
      id: "unary-1",
      input: {},
      kind: "invoke",
      mode: "unary",
    });
    await expect(session.closed).resolves.toEqual({
      code: "transport-closed",
      reason: "Gateway transport failed",
    });
    expect(transport.close).toHaveBeenCalledOnce();
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

describe("Module Gateway teardown", () => {
  it("answers a cancel at once and closes only after the provider cleans up", async () => {
    const cleanup = Promise.withResolvers<undefined>();
    let started = false;
    let cleaned = false;
    const { session, transport } = await openSession(({ signal }) =>
      Promise.resolve({
        events: (async function* () {
          started = true;
          try {
            await aborted(signal);
            yield* [];
          } finally {
            await cleanup.promise;
            cleaned = true;
          }
        })(),
        mode: "stream" as const,
      })
    );
    transport.push(invocation("watch-1"));
    await vi.waitFor(() => expect(started).toBe(true));
    transport.push({ id: "watch-1", kind: "cancel" });
    await vi.waitFor(() => {
      expect(transport.send).toHaveBeenCalledWith(cancelled("watch-1"));
    });

    const closing = session.close("shutdown");
    const progress = track(closing, session.closed);
    await turns();
    expect(progress).toEqual({ close: false, closed: false });
    expect(cleaned).toBe(false);
    cleanup.resolve(undefined);
    await closing;
    expect(cleaned).toBe(true);
    await expect(session.closed).resolves.toEqual({
      code: "requested",
      reason: "shutdown",
    });
  });

  it("admits no request read after closing has begun", async () => {
    const dispatch = vi.fn(
      () => Promise.withResolvers<ModuleGatewayDispatchResult>().promise
    );
    const { session, transport } = await openSession(dispatch, {
      cancellationGraceMs: 20,
    });
    // Delivered to the waiting read, which resumes only after the abort pass.
    transport.push(invocation("late"));
    await session.close("shutdown");

    expect(dispatch).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "late" })
    );
    await expect(session.closed).resolves.toEqual({
      code: "requested",
      reason: "shutdown",
    });
  });

  it("disposes a stream that arrives after its request was cancelled", async () => {
    const dispatched = Promise.withResolvers<ModuleGatewayDispatchResult>();
    const late = lateStream();
    const { session, transport } = await openSession(() => dispatched.promise);
    transport.push(invocation("watch-1"));
    transport.push({ id: "watch-1", kind: "cancel" });
    await vi.waitFor(() => {
      expect(transport.send).toHaveBeenCalledWith(cancelled("watch-1"));
    });
    const closing = session.close("shutdown");
    const progress = track(closing, session.closed);
    await turns();
    // The dispatch is still the provider's work, so closing waits for it.
    expect(progress).toEqual({ close: false, closed: false });

    dispatched.resolve(late.result);
    await closing;
    expect(late.returned).toHaveBeenCalledOnce();
    expect(late.next).not.toHaveBeenCalled();
  });

  it("gives up on provider work after the grace, reports it, and still disposes it", async () => {
    const stuck = Promise.withResolvers<ModuleGatewayDispatchResult>();
    const failing = Promise.withResolvers<ModuleGatewayDispatchResult>();
    const late = lateStream();
    const { session, transport } = await openSession(
      ({ request }) =>
        request.id === "stuck" ? stuck.promise : failing.promise,
      { cancellationGraceMs: 20 }
    );
    transport.push(invocation("stuck"));
    transport.push(invocation("failing"));
    await turns();
    const sent = transport.send.mock.calls.length;

    await session.close("shutdown");
    await expect(session.closed).resolves.toEqual({
      abandoned: ["stuck", "failing"],
      code: "requested",
      reason: "shutdown",
    });
    // What arrives late is still disposed, and a late failure is handled.
    stuck.resolve(late.result);
    failing.reject(new Error("Provider failed after the session closed"));
    await vi.waitFor(() => {
      expect(late.returned).toHaveBeenCalledOnce();
    });
    expect(transport.send).toHaveBeenCalledTimes(sent);
  });

  it("settles at once when the transport fails while a provider cleans up", async () => {
    const cleanup = Promise.withResolvers<undefined>();
    const { session, transport } = await openSession(() =>
      Promise.resolve({
        events: (async function* () {
          try {
            yield { step: 1 };
          } finally {
            await cleanup.promise;
          }
        })(),
        mode: "stream" as const,
      })
    );
    transport.send.mockRejectedValue(new Error("Socket failed"));
    transport.push(invocation("watch-1"));
    await vi.waitFor(() => {
      expect(transport.close).toHaveBeenCalledOnce();
    });
    const progress = track(Promise.resolve(), session.closed);
    await turns();
    expect(progress.closed).toBe(false);
    cleanup.resolve(undefined);
    await expect(session.closed).resolves.toEqual({
      code: "transport-closed",
      reason: "Gateway transport failed",
    });
  });

  it("gives every close the one settlement", async () => {
    const { session, transport } = await openSession();
    const held = Promise.withResolvers<undefined>();
    transport.close.mockImplementation(async () => {
      await held.promise;
      transport.disconnect();
    });
    const first = session.close("first");
    const second = session.close("second");
    const progress = track(second, session.closed);
    await turns();
    expect(progress).toEqual({ close: false, closed: false });
    held.resolve(undefined);
    await Promise.all([first, second]);
    expect(transport.close).toHaveBeenCalledOnce();
    await expect(session.closed).resolves.toEqual({
      code: "requested",
      reason: "first",
    });
  });

  it("rejects every close with the transport's close failure", async () => {
    const { session, transport } = await openSession();
    const failure = new Error("Socket close failed");
    transport.close.mockRejectedValue(failure);
    const first = session.close("first");
    const second = session.close("second");
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    await expect(session.closed).resolves.toEqual({
      code: "requested",
      reason: "first",
    });
  });

  it("settles when closing the transport calls close again", async () => {
    const { session, transport } = await openSession();
    const reentered: Promise<void>[] = [];
    transport.close.mockImplementation(() => {
      reentered.push(session.close("from the transport"));
      transport.disconnect();
      return Promise.resolve();
    });
    const listener = transport.closed.then(() =>
      session.close("from a listener")
    );
    await session.close("first");
    await Promise.all([...reentered, listener]);
    expect(reentered).toHaveLength(1);
    expect(transport.close).toHaveBeenCalledOnce();
    await expect(session.closed).resolves.toEqual({
      code: "requested",
      reason: "first",
    });
  });
});

async function openSession(
  dispatch: ModuleGatewayRuntimeDispatcher["dispatch"] = () =>
    Promise.resolve({ mode: "unary", output: {} }),
  options: { readonly cancellationGraceMs?: number } = {}
) {
  const fixture = await createFixture();
  const gateway = createModuleGateway({
    ...options,
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
  return { session, transport };
}

function invocation(id: string) {
  return {
    alias: "watch",
    id,
    input: {},
    kind: "invoke" as const,
    mode: "stream" as const,
  };
}

function cancelled(id: string) {
  return {
    code: "cancelled",
    id,
    kind: "failure",
    message: "Gateway request was cancelled",
  };
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** A stream result whose reads and disposal are recorded. */
function lateStream() {
  const next = vi.fn(() =>
    Promise.resolve<IteratorResult<unknown>>({ done: true, value: undefined })
  );
  const returned = vi.fn(() =>
    Promise.resolve<IteratorResult<unknown>>({ done: true, value: undefined })
  );
  const result: ModuleGatewayDispatchResult = {
    events: { [Symbol.asyncIterator]: () => ({ next, return: returned }) },
    mode: "stream",
  };
  return { next, result, returned };
}

/** Records whether a close call and the session's `closed` have settled. */
function track(close: Promise<unknown>, closed: Promise<unknown>) {
  const progress = { close: false, closed: false };
  const settle = (key: keyof typeof progress) => () => {
    progress[key] = true;
  };
  close.then(settle("close"), settle("close"));
  closed.then(settle("closed"), settle("closed"));
  return progress;
}

/** Lets every queued promise and timer callback run a few times over. */
async function turns(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

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
