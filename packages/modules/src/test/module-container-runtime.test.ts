import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Container,
  Containers,
} from "@foundry/sandbox/container/containers";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { SandboxError } from "@foundry/sandbox/errors";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import type { SandboxService } from "@foundry/sandbox/types";
import { describe, expect, it, vi } from "vitest";

import { defineModule, installationIdSchema, moduleIdSchema } from "../domain";
import { createModuleCheckouts } from "../node/checkouts";
import { createModuleSystem } from "../node/system";
import { createContainerModuleProgramRuntime } from "../platform/container-runtime";
import { ModuleRuntimeCleanupError } from "../platform/contracts";
import { ModuleStoreConflictError } from "../store/contract";
import { InMemoryModuleStore } from "../store/memory";
import { createModuleVersions } from "../version";
import {
  moduleFixture,
  PROGRAM_FILES,
  VALID_MANIFEST,
} from "./helpers/module-fixture";

async function fixture() {
  const {
    system: artifacts,
    artifact,
    content,
  } = await moduleFixture({
    files: {
      ...PROGRAM_FILES,
      "source/foundry.module.json": { bytes: JSON.stringify(VALID_MANIFEST) },
    },
  });
  const module = defineModule({ artifact, id: moduleIdSchema.parse("notes") });
  const store = new InMemoryModuleStore();
  await store.registerModule({ module });
  const version = await createModuleVersions({ artifacts, store }).load({
    contentId: content.id,
    moduleId: module.id,
  });
  if (version === null) {
    throw new Error("Expected version");
  }
  const installationId = installationIdSchema.parse("installation-runtime");
  await store.createInstallation({
    id: installationId,
    now: new Date(),
    version,
  });
  const root = await realpath(await mkdtemp(join(tmpdir(), "module-runtime-")));
  const filesPath = join(root, "files");
  const checkoutsRoot = join(root, "checkouts");
  await mkdir(filesPath);
  await mkdir(checkoutsRoot);
  const native = createFakeContainerRuntime();
  const registry = createContainers({
    allowedMountRoots: [filesPath, checkoutsRoot],
    instanceLabel: "module-runtime-test",
    mountTargetRoot: "/foundry",
    runtime: native,
    store: createMemoryContainerStore(),
  });
  const service: SandboxService = {
    id: "module-program",
    startedAt: Date.now(),
    status: "ready",
    terminate: () => new Promise(() => undefined),
    wait: () => new Promise(() => undefined),
  };
  const startService = vi.fn(() => Promise.resolve(service));
  const stopService = vi.fn(() => Promise.resolve());
  const wrap = (handle: Container): Container =>
    Object.create(handle, {
      services: {
        value: { ...handle.services, start: startService, stop: stopService },
      },
    }) as Container;
  const containers: Containers = {
    ...registry,
    open: async (id, signal) => wrap(await registry.open(id, signal)),
    start: async (spec, signal) => wrap(await registry.start(spec, signal)),
  };
  const transport = {
    close: vi.fn(() => Promise.resolve()),
    closed: new Promise<void>(() => undefined),
    incoming: {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<unknown>>(() => undefined),
      }),
    },
    send: () => Promise.resolve(),
  };
  const connect = vi.fn(() => Promise.resolve(transport));
  const fetchHealth = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response("ready"))
  );
  const options = {
    checkouts: createModuleCheckouts({ artifacts, root: checkoutsRoot }),
    containers,
    fetch: fetchHealth,
    store,
    transport: { connect },
  };
  const input = {
    files: { hostPath: filesPath, installationId },
    generation: 0,
    installationId,
    version,
  };
  return {
    artifacts,
    checkoutsRoot,
    async cleanup() {
      await registry.shutdown();
      await rm(root, { force: true, recursive: true });
    },
    connect,
    fetchHealth,
    input,
    module,
    native,
    options,
    registry,
    startService,
    stopService,
    transport,
  };
}

describe("Module container runtime", () => {
  it("composes Node adapters, management, Gateway, and supervision without owning the host registry", async () => {
    const f = await fixture();
    try {
      const unrelated = await f.registry.start({
        format: "foundry.sandbox.container/1",
      });
      let resolveClosed = (): void => undefined;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const system = createModuleSystem({
        artifacts: f.artifacts,
        checkoutsRoot: f.checkoutsRoot,
        containerRuntime: f.native,
        containers: f.options.containers,
        fetch: f.fetchHealth,
        files: {
          root: f.input.files.hostPath,
          snapshotDatabase: () =>
            Promise.reject(new Error("No database to snapshot")),
        },
        providers: [],
        store: f.options.store,
        transport: {
          connect: () =>
            Promise.resolve({
              close: () => {
                resolveClosed();
                return Promise.resolve();
              },
              closed,
              incoming: {
                [Symbol.asyncIterator]() {
                  let ready = true;
                  return {
                    next(): Promise<IteratorResult<unknown>> {
                      if (ready) {
                        ready = false;
                        return Promise.resolve({
                          done: false,
                          value: {
                            kind: "ready",
                            mode: "runtime",
                            protocol: 1,
                          },
                        });
                      }
                      return closed.then(() => ({
                        done: true,
                        value: undefined,
                      }));
                    },
                    return: () =>
                      Promise.resolve({ done: true, value: undefined }),
                  };
                },
              },
              send: () => Promise.resolve(),
            }),
        },
      });
      expect(f.native.instances).toHaveLength(1);
      const active = await system.programs.start({
        expectedGeneration: 0,
        installationId: f.input.installationId,
      });
      expect(active.generation).toBe(1);
      expect(
        (
          await system.modules.getInstallation({
            installationId: f.input.installationId,
          })
        )?.installation.status
      ).toBe("active");
      await expect(
        system.modules.selectVersion({
          contentId: f.input.version.contentId,
          expectedGeneration: 1,
          installationId: f.input.installationId,
        })
      ).rejects.toMatchObject({ code: "already-active" });
      await system.programs.stop({
        expectedGeneration: 1,
        installationId: f.input.installationId,
        reason: "disabled",
      });
      expect(
        (
          await system.modules.getInstallation({
            installationId: f.input.installationId,
          })
        )?.installation
      ).toMatchObject({ generation: 2, status: "disabled" });
      await system.modules.delete({
        expectedGeneration: 2,
        installationId: f.input.installationId,
      });
      expect(
        await system.modules.getInstallation({
          installationId: f.input.installationId,
        })
      ).toBeNull();
      await system.recovery.releaseAll("shutdown");
      expect(f.native.instances[0]?.removed).toBe(false);
      await unrelated.close();
    } finally {
      await f.cleanup();
    }
  });

  it("mounts verified code and isolated writable files, probes readiness, and reuses the refreshed registry row", async () => {
    const f = await fixture();
    try {
      const runtime = createContainerModuleProgramRuntime(f.options);
      const handle = await runtime.start(f.input);
      const row = (
        await f.options.store.loadGatewayContext(f.input.installationId)
      )?.installation;
      expect(row?.containerId).toBe(handle.runtimeInstanceId);
      expect(f.native.instances[0]?.spec).toMatchObject({
        disableNetwork: true,
        mounts: [
          {
            readOnly: true,
            source: join(f.checkoutsRoot, f.input.version.digest),
            target: "/foundry/program",
          },
          {
            readOnly: false,
            source: f.input.files.hostPath,
            target: "/foundry/files",
          },
        ],
        workdir: "/foundry/program",
      });
      expect(f.startService).toHaveBeenCalledWith(
        expect.objectContaining({
          argv: ["bun", "outputs/program/server.js"],
          environment: expect.objectContaining({
            FOUNDRY_FILES_PATH: "/foundry/files",
          }) as unknown,
          readiness: {
            intervalMs: 50,
            kind: "tcp",
            port: 3000,
            timeoutMs: 30_000,
          },
        })
      );
      expect(f.fetchHealth.mock.calls[0]?.[0]).toEqual(
        new URL("/_foundry/health", handle.programOrigin)
      );
      expect(f.connect).toHaveBeenCalledWith({
        url: new URL(
          "/_foundry/module-gateway",
          handle.programOrigin?.replace("http:", "ws:")
        ),
      });
      await handle.stop("stopped");
      expect(f.stopService).toHaveBeenCalledWith("module-program");
      expect(f.native.instances[0]?.removed).toBe(true);

      const current = await f.artifacts.getContent(f.input.version.contentId);
      if (current === null) {
        throw new Error("Expected selected Content");
      }
      const ready = await f.artifacts.revise({
        artifactId: f.module.artifactId,
        changes: {
          put: {
            "outputs/program/server.js": { bytes: "export const next = 2;" },
          },
        },
        contentId: f.input.version.contentId,
        expectedUpdatedAt: current.updatedAt,
      });
      const next = await f.artifacts.freeze(ready.id, { tag: "2.0.0" });
      const version = await createModuleVersions({
        artifacts: f.artifacts,
        store: f.options.store,
      }).load({ contentId: next.id, moduleId: f.module.id });
      if (version === null) {
        throw new Error("Expected next version");
      }
      const selected = await f.options.store.selectInstallationVersion({
        expectedGeneration: 0,
        installationId: f.input.installationId,
        now: new Date(),
        version,
      });
      const again = await runtime.start({
        ...f.input,
        generation: selected.generation,
        version,
      });
      expect(again.runtimeInstanceId).toBe(handle.runtimeInstanceId);
      expect(await f.registry.list()).toHaveLength(1);
      expect(f.native.instances[1]?.spec.mounts[0]?.source).toBe(
        join(f.checkoutsRoot, next.digest)
      );
      await again.stop("complete");
    } finally {
      await f.cleanup();
    }
  });

  it("starts a fresh container when the linked registry row no longer exists", async () => {
    const f = await fixture();
    try {
      const runtime = createContainerModuleProgramRuntime(f.options);
      const first = await runtime.start(f.input);
      await first.stop("stopped");
      await f.registry.remove(first.runtimeInstanceId);
      const restart = vi.spyOn(f.options.containers, "restart");

      const second = await runtime.start(f.input);

      expect(restart).not.toHaveBeenCalled();
      expect(second.runtimeInstanceId).not.toBe(first.runtimeInstanceId);
      expect((await f.registry.list()).map((row) => row.id)).toEqual([
        second.runtimeInstanceId,
      ]);
      expect(
        (await f.options.store.loadGatewayContext(f.input.installationId))
          ?.installation.containerId
      ).toBe(second.runtimeInstanceId);
      await second.stop("complete");
    } finally {
      await f.cleanup();
    }
  });

  it("propagates a restart failure on an existing row instead of starting another container", async () => {
    const f = await fixture();
    try {
      const runtime = createContainerModuleProgramRuntime(f.options);
      const first = await runtime.start(f.input);
      await first.stop("stopped");
      // The message the old fallback matched on; an existing row must not
      // fall back to `start` whatever the restart error says.
      const failure = new SandboxError(
        "invalid-contract",
        `container ${first.runtimeInstanceId} does not exist`
      );
      vi.spyOn(f.options.containers, "restart").mockRejectedValueOnce(failure);
      const start = vi.spyOn(f.options.containers, "start");

      await expect(runtime.start(f.input)).rejects.toBe(failure);

      expect(start).not.toHaveBeenCalled();
      expect((await f.registry.list()).map((row) => row.id)).toEqual([
        first.runtimeInstanceId,
      ]);
      expect(
        (await f.options.store.loadGatewayContext(f.input.installationId))
          ?.installation.containerId
      ).toBe(first.runtimeInstanceId);
    } finally {
      await f.cleanup();
    }
  });

  it("rejects stale selection before requesting a VM", async () => {
    const f = await fixture();
    try {
      await expect(
        createContainerModuleProgramRuntime(f.options).start({
          ...f.input,
          generation: 1,
        })
      ).rejects.toBeInstanceOf(ModuleStoreConflictError);
      expect(f.native.instances).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("retains retryable cleanup when generation changes during container acquisition", async () => {
    const f = await fixture();
    try {
      const containers = {
        ...f.options.containers,
        remove: vi
          .fn<Containers["remove"]>()
          .mockRejectedValueOnce(new Error("row cleanup failed"))
          .mockImplementation((id) => f.registry.remove(id)),
        start: async (...args: Parameters<Containers["start"]>) => {
          const handle = await f.options.containers.start(...args);
          await f.options.store.beginInstallationTransition({
            expectedGeneration: 0,
            installationId: f.input.installationId,
            now: new Date(),
            status: "starting",
          });
          return handle;
        },
      };
      let failure: unknown;
      try {
        await createContainerModuleProgramRuntime({
          ...f.options,
          containers,
        }).start(f.input);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ModuleRuntimeCleanupError);
      expect(f.native.instances[0]?.removed).toBe(true);
      expect(f.startService).not.toHaveBeenCalled();
      if (!(failure instanceof ModuleRuntimeCleanupError)) {
        throw new Error("Expected retryable cleanup");
      }
      await failure.cleanup();
      expect(await f.registry.list()).toEqual([]);
      expect(
        (await f.options.store.loadGatewayContext(f.input.installationId))
          ?.installation.containerId
      ).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  it("rejects missing mounts before running code", async () => {
    const f = await fixture();
    try {
      const containers = {
        ...f.options.containers,
        start: () =>
          f.registry.start({ format: "foundry.sandbox.container/1" }),
      };
      await expect(
        createContainerModuleProgramRuntime({ ...f.options, containers }).start(
          f.input
        )
      ).rejects.toMatchObject({ code: "mount-mismatch" });
      expect(f.native.instances[0]?.removed).toBe(true);
      expect(f.startService).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it("stops the Program and VM when Gateway connection fails after readiness", async () => {
    const f = await fixture();
    try {
      const runtime = createContainerModuleProgramRuntime({
        ...f.options,
        transport: {
          connect: () => Promise.reject(new Error("gateway refused")),
        },
      });
      await expect(runtime.start(f.input)).rejects.toThrow("gateway refused");
      expect(f.startService).toHaveBeenCalledOnce();
      expect(f.stopService).toHaveBeenCalledOnce();
      expect(f.native.instances[0]?.removed).toBe(true);
      expect((await f.registry.list())[0]?.status).toBe("stopped");
    } finally {
      await f.cleanup();
    }
  });
});
