import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { ArtifactManager, type ArtifactStore } from "@foundry/artifacts";
import {
  type InstallationId,
  installationIdSchema,
} from "@foundry/modules/domain";
import { createModuleCheckouts } from "@foundry/modules/node/checkouts";
import { createModuleInstallationFiles } from "@foundry/modules/node/installation-files";
import { createModuleSystem } from "@foundry/modules/platform/system";
import { InMemoryModuleStore } from "@foundry/modules/store/memory";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { moduleDirectory } from "../local-library";
import { type ModuleRuntime, ModuleRuntimeError } from "./controller";
import { connectModuleSocket } from "./websocket";

/** Execution is temporary; Module source, releases, and app data stay local. */
export async function createModuleRuntime(
  userData: string,
  artifactStore: ArtifactStore
): Promise<ModuleRuntime> {
  const { createMicrosandboxRuntime } = await import(
    "@foundry/sandbox/container/microsandbox-runtime"
  );
  const artifacts = new ArtifactManager({ store: artifactStore });
  const store = new InMemoryModuleStore();
  const root = path.join(userData, ".runtime");
  const checkoutsRoot = path.join(root, "checkouts");
  const filesRoot = path.join(userData, ".data");
  const runtime = createMicrosandboxRuntime();
  const containers = createContainers({
    allowedMountRoots: [checkoutsRoot, filesRoot],
    instanceLabel: createHash("sha256").update(root).digest("hex").slice(0, 16),
    mountTargetRoot: "/foundry",
    runtime,
    store: createMemoryContainerStore(),
  });
  const dataDirectories = new Map<InstallationId, InstallationId>();
  const running = new Map<string, Promise<void>>();
  const files = createModuleInstallationFiles({
    root: filesRoot,
    snapshotDatabase: () =>
      Promise.reject(new Error("Live version changes are not supported")),
  });
  function dataId(id: InstallationId) {
    const directory = dataDirectories.get(id);
    if (!directory) {
      throw new Error("Module data directory not registered");
    }
    return directory;
  }
  const system = createModuleSystem({
    artifacts,
    checkouts: createModuleCheckouts({ artifacts, root: checkoutsRoot }),
    containerRuntime: runtime,
    containers,
    files: {
      backup: (id) => files.backup(dataId(id)),
      delete: async () => {
        /* Closing an app preserves its local data. */
      },
      discardBackup: (id) => files.discardBackup(dataId(id)),
      prepare: async (input) => ({
        ...(await files.prepare({
          ...input,
          installationId: dataId(input.installationId),
        })),
        installationId: input.installationId,
      }),
      release: (id) => files.release(dataId(id)),
      restoreBackup: (id) => files.restoreBackup(dataId(id)),
    },
    providers: [],
    store,
    transport: { connect: connectModuleSocket },
  });
  let prepared: Promise<void> | undefined;
  async function prepare() {
    prepared ??= (async () => {
      await mkdir(checkoutsRoot, { mode: 0o700, recursive: true });
      await mkdir(filesRoot, { mode: 0o700, recursive: true });
      if (!(await runtime.isInstalled())) {
        throw new ModuleRuntimeError(
          "Modules require the Microsandbox runtime. Install it before opening an app."
        );
      }
      await containers.sweep();
    })().catch((error: unknown) => {
      prepared = undefined;
      throw error;
    });
    await prepared;
  }
  return {
    async shutdown() {
      await system.programs.shutdown("Works closed");
      await containers.shutdown();
      await rm(root, { force: true, recursive: true });
    },
    async start(version, signal) {
      signal.throwIfAborted();
      await prepare();
      signal.throwIfAborted();
      while (running.has(version.moduleId)) {
        const previous = running.get(version.moduleId);
        if (previous) {
          await waitForClose(previous, signal);
        }
      }
      signal.throwIfAborted();
      const slot = Promise.withResolvers<void>();
      running.set(version.moduleId, slot.promise);
      const module = { artifactId: version.artifactId, id: version.moduleId };
      let installationId: InstallationId | undefined;
      async function close() {
        if (installationId) {
          const current = await store.loadGatewayContext(installationId);
          if (current) {
            await system.programs.delete({
              expectedGeneration: current.installation.generation,
              installationId,
            });
          }
          dataDirectories.delete(installationId);
        }
        running.delete(module.id);
        slot.resolve();
      }
      try {
        await store.registerModule({ module });
        await store.retainManifest({
          contentId: version.contentId,
          manifest: version.manifest,
          module,
        });
        const installation = await system.modules.createInstallation({
          contentId: version.contentId,
          moduleId: module.id,
        });
        installationId = installation.id;
        dataDirectories.set(
          installation.id,
          installationIdSchema.parse(moduleDirectory(module.id))
        );
        await system.programs.start({
          expectedGeneration: installation.generation,
          installationId: installation.id,
          signal,
        });
        const endpoint = await system.programs.viewEndpoint({
          installationId: installation.id,
        });
        if (!endpoint) {
          throw new Error("Module did not publish a view endpoint");
        }
        return { close, origin: endpoint.origin };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}

async function waitForClose(previous: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([previous, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
