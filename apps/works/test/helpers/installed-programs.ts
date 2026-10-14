import type { ArtifactStore } from "@foundry/artifacts";
import { runtimeInstanceIdSchema } from "@foundry/modules/domain";
import { createModuleGatewayRuntimeDispatcher } from "@foundry/modules/gateway/runtime-dispatcher";
import type {
  ModuleGateway,
  ModuleGatewayClose,
} from "@foundry/modules/gateway/types";
import {
  approvedNetworkDestinations,
  type NetworkDestination,
} from "@foundry/modules/grants";
import type { ModuleInstallationFiles } from "@foundry/modules/platform/files";
import { createModuleProgramSupervisor } from "@foundry/modules/platform/program-supervisor";
import { createModuleRuntimeRecovery } from "@foundry/modules/platform/runtime-recovery";
import { createModuleVersions } from "@foundry/modules/version";
import { vi } from "vitest";
import type { WorksExecution } from "~/main/execution/contract";
import type { WorksCapability } from "~/main/gateway/provider-kit";
import { ModuleAccess, networkAccess } from "~/main/modules/access";
import { modulePersistence } from "~/main/modules/artifact-store";
import {
  capabilityProviders,
  worksCapabilityCatalog,
} from "~/main/modules/capabilities";
import { createModuleLibrary } from "~/main/modules/library";
import { ModuleSessions } from "~/main/modules/runtime/controller";
import { createInstalledPrograms } from "~/main/modules/runtime/installed";
import type { ProgramCalls } from "~/main/modules/runtime/program-calls";
import { createModuleReleaseFiles } from "~/main/modules/runtime/release-files";
import type { ModuleRuntimeOptions } from "~/main/modules/runtime/runtime";
import { SandboxCapacity } from "~/main/modules/sandboxes/capacity";
import { publishStrict } from "./module-build";
import { unrecordedSaves } from "./source-saves";

/**
 * Works' installed runtime as `createModuleRuntime` builds it, over the real
 * Artifact-backed ModuleStore, supervisor, recovery and Gateway dispatcher,
 * with each Module's `artifact/` under `root`. Only the VM and the Gateway
 * connection are stand-ins: a Program "starts" at once, after resolving its
 * `artifact/` like the container runtime does, and its session never
 * closes by itself. `composeWorks` takes it as its `programs`.
 */
export function fakePrograms(options: ModuleRuntimeOptions) {
  const { root } = options;
  const { artifacts, modules } = options.persistence;
  const releases = createModuleReleaseFiles({ artifacts, root });
  /** The `artifact/` each started Program was given. */
  const mounted: string[] = [];
  /** The network each started Program was given: destinations, or none. */
  const networks: (readonly NetworkDestination[] | null)[] = [];
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
  let runtimes = 0;
  const stopped = vi.fn(() => Promise.resolve());
  const gateway = {
    connect: () =>
      Promise.resolve({
        close: () => Promise.resolve(),
        closed: new Promise<ModuleGatewayClose>(() => undefined),
        mode: "runtime",
        publishCatalogChange: () => Promise.resolve(),
      }),
  } as unknown as ModuleGateway;
  const programs = createModuleProgramSupervisor({
    files,
    gateway,
    removeContainer: () => Promise.resolve(),
    runtime: {
      start: async ({ installationId, version }) => {
        mounted.push((await releases.ensure({ version })).hostPath);
        // The network policy the container runtime would give this VM.
        networks.push(
          await approvedNetworkDestinations({
            grants:
              (await modules.loadGatewayContext(installationId))?.grants ?? [],
            manifest: version.manifest,
          })
        );
        runtimes += 1;
        return Promise.resolve({
          programOrigin: "http://program.test",
          runtimeInstanceId: runtimeInstanceIdSchema.parse(
            `runtime-${String(runtimes)}`
          ),
          stop: stopped,
          transport: {} as never,
        });
      },
    },
    stopRetainedContainer: () => Promise.resolve(),
    store: modules,
    versions: createModuleVersions({ artifacts, store: modules }),
  });
  const invocations = createModuleGatewayRuntimeDispatcher({
    ...(options.observeInvocation === undefined
      ? {}
      : { observe: options.observeInvocation }),
    providers: options.providers,
    store: modules,
  });
  const runtime = createInstalledPrograms({
    capacity: options.capacity,
    execution: options.execution,
    files: { stopped: () => Promise.resolve() },
    providers: options.providers,
    releases,
    settings: options.settings ?? { user: () => Promise.resolve({}) },
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
    store: modules,
    system: {
      invocations,
      programs,
      recovery: createModuleRuntimeRecovery({
        store: modules,
        supervisor: programs,
      }),
    },
  });
  return {
    artifacts,
    invocations,
    modules,
    mounted,
    networks,
    programs,
    releases,
    runtime,
    stopped,
  };
}

/**
 * One Works "process" over `store`: {@link fakePrograms} with the library,
 * sessions and Access around it, Access over `capabilities` and `network`.
 */
export function installedProcess(
  store: ArtifactStore,
  execution: Pick<WorksExecution, "dispatch">,
  root: string,
  capabilities: readonly WorksCapability[] = [],
  options: {
    /** Records each Program's Gateway invocations on its lifetime run. */
    readonly calls?: ProgramCalls;
    readonly stopped?: (installationId: string) => Promise<void>;
  } = {}
) {
  const providers = capabilityProviders(capabilities);
  const programs = fakePrograms({
    capacity: new SandboxCapacity(),
    execution,
    ...(options.calls === undefined
      ? {}
      : { observeInvocation: options.calls.record }),
    persistence: modulePersistence(store),
    providers,
    root,
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
  });
  const { modules, runtime } = programs;
  const library = createModuleLibrary(store, {
    catalog: worksCapabilityCatalog(providers),
    saves: unrecordedSaves,
  });
  const sessions = new ModuleSessions({
    ...(options.calls === undefined ? {} : { calls: options.calls }),
    execution,
    library,
    runtime,
  });
  const access = new ModuleAccess({
    capabilities: [
      ...capabilities,
      networkAccess((moduleId) => sessions.restart(moduleId)),
    ],
    execution,
    library,
    runtime,
    store: modules,
  });
  const release = (moduleId: string, tag: string, manifest: object) =>
    publishStrict(library, moduleId, tag, manifest);
  return { ...programs, access, library, release, sessions };
}
