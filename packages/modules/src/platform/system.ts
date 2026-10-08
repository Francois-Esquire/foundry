import type { Artifacts } from "@foundry/artifacts";
import type { Containers } from "@foundry/sandbox/container/containers";
import type { ContainerRuntime } from "@foundry/sandbox/container/types";

import type { InstallationId } from "../domain";
import { createModuleGateway } from "../gateway/module-gateway";
import { createModuleGatewayRuntimeDispatcher } from "../gateway/runtime-dispatcher";
import type { ModuleCapabilityProvider } from "../gateway/types";
import { createModuleManagement } from "../management";
import type { ModuleStore } from "../store/contract";
import { createModuleVersions } from "../version";
import { withConfirmedModuleContainerCleanup } from "./container-cleanup";
import type { CreateContainerModuleProgramRuntimeOptions } from "./container-runtime";
import { createContainerModuleProgramRuntime } from "./container-runtime";
import type { ModuleCheckouts, ModuleInstallationFiles } from "./files";
import { createModuleProgramSupervisor } from "./program-supervisor";
import { createModuleRuntimeRecovery } from "./runtime-recovery";

export interface CreateModuleSystemOptions {
  readonly artifacts: Artifacts;
  readonly checkouts: ModuleCheckouts;
  /** The backend used by containers, for confirming retained native cleanup. */
  readonly containerRuntime: Pick<
    ContainerRuntime,
    "listResources" | "stopResource" | "removeResource"
  >;
  readonly containers: Containers;
  readonly fetch?: CreateContainerModuleProgramRuntimeOptions["fetch"];
  readonly files: ModuleInstallationFiles;
  readonly onSettledTransition?: (installationId: InstallationId) => void;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly store: ModuleStore;
  readonly transport: CreateContainerModuleProgramRuntimeOptions["transport"];
}

export function createModuleSystem(options: CreateModuleSystemOptions) {
  const { artifacts, store, files } = options;
  const containers = withConfirmedModuleContainerCleanup(
    options.containers,
    options.containerRuntime
  );
  const versions = createModuleVersions({ artifacts, store });
  const invocations = createModuleGatewayRuntimeDispatcher({
    providers: options.providers,
    store,
  });
  const gateway = createModuleGateway({
    runtimeDispatcher: invocations,
    store,
  });
  const programs = createModuleProgramSupervisor({
    files,
    gateway,
    removeContainer: (id) => containers.remove(id),
    runtime: createContainerModuleProgramRuntime({
      checkouts: options.checkouts,
      containers,
      store,
      transport: options.transport,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    stopRetainedContainer: (id) => containers.stopRetained(id),
    store,
    versions,
    ...(options.onSettledTransition === undefined
      ? {}
      : { onSettledTransition: options.onSettledTransition }),
  });
  return Object.freeze({
    gateway,
    invocations,
    modules: createModuleManagement({ artifacts, programs, store }),
    programs,
    recovery: createModuleRuntimeRecovery({ store, supervisor: programs }),
  });
}

export type ModuleSystem = ReturnType<typeof createModuleSystem>;
