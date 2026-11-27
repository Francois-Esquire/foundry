import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Artifacts } from "@foundry/artifacts";
import type { ArtifactStore } from "@foundry/artifacts/store";
import {
  type InstallationId,
  installationIdSchema,
  Modules,
} from "@foundry/modules";
import {
  createModuleCheckouts,
  createModuleInstallationFiles,
} from "@foundry/modules/node";
import {
  createModuleInstallations,
  createModulePlatform,
  ModuleActivationRefusedError,
} from "@foundry/modules/platform";
import { createContainers } from "@foundry/sandbox";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { moduleDirectory } from "../local-library";
import { type ModuleRuntime, ModuleRuntimeError } from "./controller";
import { WORKS_MODULE_SETTINGS, worksModuleLaunch } from "./launch";
import { connectModuleSocket } from "./websocket";

export async function createModuleRuntime(
  userData: string,
  artifactStore: ArtifactStore
): Promise<ModuleRuntime> {
  const { createMicrosandboxDriver } = await import(
    "@foundry/sandbox/providers/microsandbox"
  );
  const artifacts = new Artifacts({ store: artifactStore });
  const store = new Modules({
    artifactOfContent: async (contentId) =>
      (await artifacts.getContent(contentId))?.artifactId ?? null,
  });
  const root = path.join(userData, ".runtime");
  const checkoutsRoot = path.join(root, "checkouts");
  const filesRoot = path.join(userData, ".data");
  const driver = createMicrosandboxDriver({
    allowedMountRoots: [checkoutsRoot, filesRoot],
  });
  const containers = createContainers({
    driver,
    instanceLabel: createHash("sha256").update(root).digest("hex").slice(0, 16),
    mountTargetRoot: "/foundry",
    store: new MemoryContainerStore(),
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
  const system = createModulePlatform({
    artifacts,
    checkouts: createModuleCheckouts({ artifacts, root: checkoutsRoot }),
    containers,
    files: {
      backup: (id) => files.backup(dataId(id)),
      delete: (id) => files.release(dataId(id)),
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
  const installations = createModuleInstallations({
    programs: system.programs,
    providers: [],
    store,
  });
  let prepared: Promise<void> | undefined;
  async function prepare() {
    prepared ??= (async () => {
      await mkdir(checkoutsRoot, { mode: 0o700, recursive: true });
      await mkdir(filesRoot, { mode: 0o700, recursive: true });
      if (driver.isInstalled !== undefined && !(await driver.isInstalled())) {
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
        await installations
          .start({
            installation,
            launch: worksModuleLaunch(version),
            settings: WORKS_MODULE_SETTINGS,
            signal,
            version,
          })
          .catch((error: unknown) => {
            if (error instanceof ModuleActivationRefusedError) {
              throw new ModuleRuntimeError(
                `This release cannot run here: ${error.facts.map((fact) => fact.detail).join("; ")}`,
                { cause: error }
              );
            }
            throw error;
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
