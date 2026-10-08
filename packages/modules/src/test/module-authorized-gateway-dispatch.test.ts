import { describe, expect, it, vi } from "vitest";
import {
  createDisabledInstallation,
  defineModule,
  defineModuleVersion,
  installationIdSchema,
  moduleIdSchema,
  runtimeInstanceIdSchema,
} from "../domain";
import { createModuleGatewayRuntimeDispatcher } from "../gateway/runtime-dispatcher";
import type {
  ModuleCapabilityProvider,
  ModuleCapabilitySchema,
  ModuleGatewayInvocationFrame,
  ModuleRuntimeIdentity,
} from "../gateway/types";
import { PORTABLE_SCHEMA_DIALECT } from "../manifest";
import { InMemoryModuleStore } from "../store/memory";
import { moduleFixture } from "./helpers/module-fixture";

const objectSchema = {
  $schema: PORTABLE_SCHEMA_DIALECT,
  type: "object",
} as const;
const schema: ModuleCapabilitySchema<unknown> = {
  description: objectSchema,
  parse: (value) => value,
};
const request: ModuleGatewayInvocationFrame = {
  alias: "notify",
  id: "request-1",
  input: { title: "hello" },
  kind: "invoke",
  mode: "unary",
};

describe("authorized Module Gateway dispatch", () => {
  it("invokes a granted unary capability and returns its parsed output", async () => {
    const fixture = await createFixture();
    const invoke = vi.fn(
      (_value: unknown, _context?: { readonly signal: AbortSignal }) =>
        Promise.resolve({ delivered: true })
    );
    const dispatcher = createModuleGatewayRuntimeDispatcher({
      providers: [provider({ invoke })],
      store: fixture.store,
    });

    await expect(
      dispatcher.dispatch({
        capabilities: fixture.capabilities,
        request,
        runtime: fixture.runtime,
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ mode: "unary", output: { delivered: true } });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      invocationId: "runtime:runtime-1:request:request-1",
      principal: {
        contentId: fixture.runtime.contentId,
        generation: fixture.runtime.generation,
        installationId: fixture.runtime.installationId,
        moduleId: "module-1",
      },
    });
  });

  it("reports cancellation when it wins before the provider returns", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    let completeProvider: ((value: unknown) => void) | undefined;
    const invoke = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          completeProvider = resolve;
        })
    );
    const dispatcher = createModuleGatewayRuntimeDispatcher({
      providers: [provider({ invoke })],
      store: fixture.store,
    });

    const dispatch = dispatcher.dispatch({
      capabilities: fixture.capabilities,
      request,
      runtime: fixture.runtime,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledOnce();
    });
    controller.abort();
    completeProvider?.({ delivered: true });

    await expect(dispatch).rejects.toMatchObject({ code: "cancelled" });
  });

  it("aborts unary work of a revoked capability", async () => {
    const fixture = await createFixture();
    let providerSignal: AbortSignal | undefined;
    let completeProvider: ((value: unknown) => void) | undefined;
    const invoke = vi.fn(
      (_value: unknown, context?: { readonly signal: AbortSignal }) => {
        providerSignal = context?.signal;
        return new Promise<unknown>((resolve) => {
          completeProvider = resolve;
        });
      }
    );
    const dispatcher = createModuleGatewayRuntimeDispatcher({
      providers: [provider({ invoke })],
      store: fixture.store,
    });

    const dispatch = dispatcher.dispatch({
      capabilities: fixture.capabilities,
      request,
      runtime: fixture.runtime,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledOnce();
    });
    dispatcher.revoke({
      capability: "platform.notifications",
      installationId: fixture.runtime.installationId,
      reason: "Module Grant was revoked",
    });
    expect(providerSignal?.aborted).toBe(true);
    completeProvider?.({ delivered: true });

    await expect(dispatch).rejects.toMatchObject({ code: "cancelled" });
  });

  it.each([
    [
      "undeclared alias",
      { ...request, alias: "missing" },
      provider({}),
      "unknown-alias",
    ],
    ["unavailable provider", request, undefined, "unknown-capability"],
    [
      "invalid input",
      request,
      provider({
        input: {
          ...schema,
          parse: () => {
            throw new Error("invalid");
          },
        },
      }),
      "invalid-input",
    ],
    [
      "denied constraints",
      request,
      provider({ resolveConstraints: () => Promise.reject(new Error("no")) }),
      "unauthorized",
    ],
  ] as const)(
    "fails %s before any provider effect",
    async (_name, deniedRequest, candidate, code) => {
      const fixture = await createFixture();
      const dispatcher = createModuleGatewayRuntimeDispatcher({
        providers: candidate === undefined ? [] : [candidate],
        store: fixture.store,
      });

      await expect(
        dispatcher.dispatch({
          capabilities: fixture.capabilities,
          request: deniedRequest,
          runtime: fixture.runtime,
          signal: new AbortController().signal,
        })
      ).rejects.toMatchObject({ code });
    }
  );

  it("denies a missing Grant and prevents provider effects", async () => {
    const fixture = await createFixture({ grant: false });
    const invoke = vi.fn(() => Promise.resolve({ delivered: true }));
    const dispatcher = createModuleGatewayRuntimeDispatcher({
      providers: [provider({ invoke })],
      store: fixture.store,
    });

    await expect(
      dispatcher.dispatch({
        capabilities: fixture.capabilities,
        request,
        runtime: fixture.runtime,
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("treats a Runtime whose Installation is no longer running as stale", async () => {
    const fixture = await createFixture();
    const invoke = vi.fn(() => Promise.resolve({ delivered: true }));
    const dispatcher = createModuleGatewayRuntimeDispatcher({
      providers: [provider({ invoke })],
      store: fixture.store,
    });
    await fixture.store.settleInstallationStatus({
      expectedGeneration: fixture.runtime.generation,
      installationId: fixture.runtime.installationId,
      now: new Date("2026-08-09T00:03:00.000Z"),
      status: "failed",
    });

    await expect(
      dispatcher.dispatch({
        capabilities: fixture.capabilities,
        request,
        runtime: fixture.runtime,
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: "stale-runtime" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("streams events and stops on cancellation", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const dispatcher = createModuleGatewayRuntimeDispatcher({
      providers: [streamProvider()],
      store: fixture.store,
    });

    const result = await dispatcher.dispatch({
      capabilities: fixture.capabilities,
      request: { ...request, mode: "stream" },
      runtime: fixture.runtime,
      signal: controller.signal,
    });
    if (result.mode !== "stream") {
      throw new Error("expected stream");
    }
    const iterator = result.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { step: 1 },
    });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });
  });

  it("aborts streamed work of a revoked capability", async () => {
    const fixture = await createFixture();
    const dispatcher = createModuleGatewayRuntimeDispatcher({
      providers: [streamProvider()],
      store: fixture.store,
    });

    const result = await dispatcher.dispatch({
      capabilities: fixture.capabilities,
      request: { ...request, mode: "stream" },
      runtime: fixture.runtime,
      signal: new AbortController().signal,
    });
    if (result.mode !== "stream") {
      throw new Error("expected stream");
    }
    const iterator = result.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { step: 1 },
    });
    dispatcher.revoke({
      capability: "platform.notifications",
      installationId: fixture.runtime.installationId,
      reason: "Module Grant was revoked",
    });

    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });
  });
});

function provider(
  input: {
    readonly invoke?: (
      value: unknown,
      context?: { readonly signal: AbortSignal }
    ) => Promise<unknown>;
    readonly input?: ModuleCapabilitySchema<unknown>;
    readonly resolveConstraints?: ModuleCapabilityProvider["resolveConstraints"];
  } = {}
): ModuleCapabilityProvider {
  return {
    registration: {
      descriptor: {
        capability: "platform.notifications",
        documentation: "Send a notification.",
        input: objectSchema,
        output: objectSchema,
        version: 1,
      },
      input: input.input ?? schema,
      invoke: input.invoke ?? (() => Promise.resolve({ delivered: true })),
      mode: "unary",
      output: schema,
    },
    resolveConstraints:
      input.resolveConstraints ??
      (() => Promise.resolve({ constraintsDigest: "digest" })),
  };
}

function streamProvider(): ModuleCapabilityProvider {
  return {
    registration: {
      descriptor: {
        capability: "platform.notifications",
        documentation: "Observe notifications.",
        event: objectSchema,
        input: objectSchema,
        version: 1,
      },
      event: schema,
      input: schema,
      async *invoke() {
        await Promise.resolve();
        yield { step: 1 };
        yield { step: 2 };
      },
      mode: "stream",
    },
    resolveConstraints: () => Promise.resolve({ constraintsDigest: "digest" }),
  };
}

async function createFixture(input: { readonly grant?: boolean } = {}) {
  const { artifact, content } = await moduleFixture({
    files: { "outputs/program/index.js": { bytes: "" } },
  });
  const module = defineModule({
    artifact,
    id: moduleIdSchema.parse("module-1"),
  });
  const version = defineModuleVersion({
    artifact,
    content,
    manifest: {
      capabilities: [
        {
          alias: "notify",
          capability: "platform.notifications",
          reason: "Notify users.",
          version: 1,
        },
      ],
      compatibility: { gateway: "1", runtime: "bun@1" },
      format: "foundry.module/1",
      program: { entry: "outputs/program/index.js" },
      views: {},
    },
    module,
  });
  const store = new InMemoryModuleStore();
  await store.registerModule({ module });
  const initial = createDisabledInstallation({
    id: installationIdSchema.parse("installation-1"),
    now: new Date("2026-08-09T00:00:00.000Z"),
    version,
  });
  await store.createInstallation({
    id: initial.id,
    now: initial.createdAt,
    version,
  });
  const installation = await store.beginInstallationTransition({
    expectedGeneration: 0,
    installationId: initial.id,
    now: new Date("2026-08-09T00:01:00.000Z"),
    status: "starting",
  });
  if (input.grant !== false) {
    await store.replaceInstallationGrants({
      expectedGeneration: installation.generation,
      grants: [
        {
          capability: "platform.notifications",
          constraintsDigest: "digest",
          version: 1,
        },
      ],
      installationId: installation.id,
      now: new Date("2026-08-09T00:01:00.000Z"),
    });
  }
  const context = await store.loadGatewayContext(installation.id);
  if (context === null) {
    throw new Error("missing context");
  }
  const runtime: ModuleRuntimeIdentity = Object.freeze({
    contentId: version.contentId,
    generation: context.installation.generation,
    installationId: context.installation.id,
    runtimeInstanceId: runtimeInstanceIdSchema.parse("runtime-1"),
  });
  return { capabilities: version.manifest.capabilities, runtime, store };
}
