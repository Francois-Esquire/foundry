import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { ArtifactManager, type ArtifactStore } from "@foundry/artifacts";
import { createModuleCheckouts } from "@foundry/modules/node/checkouts";
import { createModuleInstallationFiles } from "@foundry/modules/node/installation-files";
import { createModuleSystem } from "@foundry/modules/platform/system";
import { InMemoryModuleStore } from "@foundry/modules/store/memory";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { ModulePreviewError, type PreviewRuntime } from "./controller";
import { connectModuleSocket } from "./websocket";

/** Preview Installations are temporary; the library retains the released bytes. */
export async function createPreviewRuntime(
  userData: string,
  artifactStore: ArtifactStore
): Promise<PreviewRuntime> {
  const { createMicrosandboxRuntime } = await import(
    "@foundry/sandbox/container/microsandbox-runtime"
  );
  const artifacts = new ArtifactManager({ store: artifactStore });
  const store = new InMemoryModuleStore();
  const root = path.join(userData, "modules", "preview");
  const checkoutsRoot = path.join(root, "checkouts");
  const filesRoot = path.join(root, "files");
  const runtime = createMicrosandboxRuntime();
  const containers = createContainers({
    allowedMountRoots: [checkoutsRoot, filesRoot],
    instanceLabel: createHash("sha256").update(root).digest("hex").slice(0, 16),
    mountTargetRoot: "/foundry",
    runtime,
    store: createMemoryContainerStore(),
  });
  const system = createModuleSystem({
    artifacts,
    checkouts: createModuleCheckouts({ artifacts, root: checkoutsRoot }),
    containerRuntime: runtime,
    containers,
    files: createModuleInstallationFiles({
      root: filesRoot,
      snapshotDatabase: () =>
        Promise.reject(new Error("Preview version changes are not supported")),
    }),
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
        throw new ModulePreviewError(
          "Module previews require the Microsandbox runtime. Install it before starting a preview."
        );
      }
      await containers.sweep();
      await rm(filesRoot, { force: true, recursive: true });
      await mkdir(filesRoot, { mode: 0o700, recursive: true });
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
    },
    async start(version, signal) {
      signal.throwIfAborted();
      await prepare();
      signal.throwIfAborted();
      const module = { artifactId: version.artifactId, id: version.moduleId };
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
      async function close() {
        const current = await store.loadGatewayContext(installation.id);
        if (current) {
          await system.programs.delete({
            expectedGeneration: current.installation.generation,
            installationId: installation.id,
          });
        }
      }
      try {
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
