import type { ArtifactSubstrate } from "@foundry/artifacts";
import type { ContainerRuntime, Containers } from "@foundry/sandbox";

import type { InstallationId } from "../domain";
import { createModuleGateway } from "../gateway/module-gateway";
import { createModuleGatewayRuntimeDispatcher } from "../gateway/runtime-dispatcher";
import type {
  ModuleCapabilityProvider,
  ModuleGatewayInvocationRecord,
} from "../gateway/types";
import { createModuleManagement } from "../management";
import type { ModuleCommands } from "../modules";
import { createModuleVersions } from "../version";
import { withConfirmedModuleContainerCleanup } from "./container-cleanup";
import type { CreateContainerModuleProgramRuntimeOptions } from "./container-runtime";
import { createContainerModuleProgramRuntime } from "./container-runtime";
import type { ModuleCheckouts, ModuleInstallationFiles } from "./files";
import { createModuleProgramSupervisor } from "./program-supervisor";
import { createModuleRuntimeRecovery } from "./runtime-recovery";

export interface CreateModulePlatformOptions {
  readonly artifacts: ArtifactSubstrate;
  readonly checkouts: ModuleCheckouts;
  readonly containerRuntime: Pick<
    ContainerRuntime,
    "listResources" | "stopResource" | "removeResource"
  >;
  readonly containers: Containers;
  readonly fetch?: CreateContainerModuleProgramRuntimeOptions["fetch"];
  readonly files: ModuleInstallationFiles;
  readonly observeInvocation?: (record: ModuleGatewayInvocationRecord) => void;
  readonly onSettledTransition?: (installationId: InstallationId) => void;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly store: ModuleCommands;
  readonly transport: CreateContainerModuleProgramRuntimeOptions["transport"];
}

export function createModulePlatform(options: CreateModulePlatformOptions) {
  const { artifacts, store, files } = options;
  const containers = withConfirmedModuleContainerCleanup(
    options.containers,
    options.containerRuntime
  );
  const versions = createModuleVersions({ artifacts, store });
  const invocations = createModuleGatewayRuntimeDispatcher({
    ...(options.observeInvocation === undefined
      ? {}
      : { observe: options.observeInvocation }),
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

export type ModulePlatform = ReturnType<typeof createModulePlatform>;
