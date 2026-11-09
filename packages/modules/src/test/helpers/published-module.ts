import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { vi } from "vitest";

import { moduleIdSchema, runtimeInstanceIdSchema } from "../../domain";
import type {
  ModuleCapabilityCatalog,
  ModuleCapabilityProvider,
  ModuleGateway,
  ModuleGatewayClose,
} from "../../gateway/types";
import type { ModuleInstallationFiles } from "../../platform/files";
import { createModuleProgramSupervisor } from "../../platform/program-supervisor";
import { createModuleProjects } from "../../projects";
import { InMemoryModuleStore } from "../../store/memory";
import { createModuleVersions } from "../../version";

export const WEATHER = "host.weather.read";

/** A strict Manifest whose Program is a built server output. */
export function builtManifest(capabilities: readonly object[] = []) {
  return {
    capabilities,
    compatibility: { gateway: "1", runtime: "bun@1" },
    format: "foundry.module-manifest/1",
    program: { entry: "outputs/packages/server/dist/index.js" },
    views: { home: { path: "/" } },
  };
}

/** A request for {@link WEATHER} limited to `cities`. */
export function weatherRequest(
  cities: readonly string[],
  required = true
): object {
  return {
    alias: "weather",
    capability: WEATHER,
    constraints: { cities },
    reason: "Shows the forecast",
    required,
    version: 1,
  };
}

/** Resolves {@link WEATHER} constraints to a digest naming the cities. */
export const weatherProvider = {
  registration: { descriptor: { capability: WEATHER, version: 1 } },
  resolveConstraints: ({
    releaseConstraints,
  }: {
    releaseConstraints: unknown;
  }) =>
    Promise.resolve({
      constraintsDigest: `cities:${JSON.stringify(releaseConstraints)}`,
    }),
} as unknown as ModuleCapabilityProvider;

const catalog = {
  capabilities: [{ capability: WEATHER, version: 1 }],
} as unknown as Pick<ModuleCapabilityCatalog, "capabilities">;

/**
 * One Module over in-memory Artifacts and Store, with Versions published
 * through `ModuleProjects.publish` from saved source, and a supervisor whose
 * Programs "start" at once without a VM.
 */
export async function publishedModule() {
  const artifacts = new ArtifactManager({ store: new InMemoryArtifactStore() });
  const store = new InMemoryModuleStore();
  const projects = createModuleProjects({ artifacts, store });
  const moduleId = moduleIdSchema.parse("forecast");
  await projects.create({
    id: moduleId,
    name: "Forecast",
    source: { "foundry.module.json": JSON.stringify(builtManifest()) },
  });

  /** Saves `capabilities` into the Manifest and publishes it as `tag`. */
  async function publish(tag: string, capabilities: readonly object[] = []) {
    const saved = await projects.workspaceSource({ moduleId });
    const source = {
      ...saved.source,
      "foundry.module.json": JSON.stringify(builtManifest(capabilities)),
    };
    const expected = await projects.saveWorkspaceSource({
      expected: saved.binding,
      moduleId,
      source,
    });
    const published = await projects.publish({
      catalog,
      expected,
      moduleId,
      outputs: {
        "packages/server/dist/index.js": new TextEncoder().encode(
          `export const tag = "${tag}";`
        ),
      },
      source,
      tag,
    });
    return published.version;
  }

  const files = {
    backup: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
    discardBackup: vi.fn(() => Promise.resolve()),
    prepare: vi.fn(
      ({ installationId }: Parameters<ModuleInstallationFiles["prepare"]>[0]) =>
        Promise.resolve({ hostPath: "/files", installationId })
    ),
    release: vi.fn(() => Promise.resolve()),
    restoreBackup: vi.fn(() => Promise.resolve(false)),
  };
  const gateway = {
    connect: () =>
      Promise.resolve({
        close: () => Promise.resolve(),
        closed: new Promise<ModuleGatewayClose>(() => undefined),
        mode: "runtime",
        publishCatalogChange: () => Promise.resolve(),
      }),
  } as unknown as ModuleGateway;
  let runtimes = 0;
  const start = vi.fn(() => {
    runtimes += 1;
    return Promise.resolve({
      programOrigin: "http://program.test",
      runtimeInstanceId: runtimeInstanceIdSchema.parse(`runtime-${runtimes}`),
      stop: () => Promise.resolve(),
      transport: {} as never,
    });
  });
  const programs = createModuleProgramSupervisor({
    files,
    gateway,
    removeContainer: () => Promise.resolve(),
    runtime: { start },
    stopRetainedContainer: () => Promise.resolve(),
    store,
    versions: createModuleVersions({ artifacts, store }),
  });
  return { artifacts, moduleId, programs, projects, publish, start, store };
}
