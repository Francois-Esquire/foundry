import type { ArtifactSubstrate } from "@foundry/artifacts";
import type { Authorization } from "@foundry/authorization";
import type { Containers, Driver } from "@foundry/sandbox";

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
import type { CreateContainerModuleProgramRuntimeOptions } from "./container-runtime";
import { createContainerModuleProgramRuntime } from "./container-runtime";
import type { ModuleCheckouts, ModuleInstallationFiles } from "./files";
import { createModuleProgramSupervisor } from "./program-supervisor";
import { createModuleRuntimeRecovery } from "./runtime-recovery";

export interface CreateModulePlatformOptions {
  readonly artifacts: ArtifactSubstrate;
  readonly authorization?: Authorization;
  readonly checkouts: ModuleCheckouts;
  /** @deprecated */
  readonly containerRuntime?: Pick<
    Driver,
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
  const { artifacts, containers, store, files } = options;
  const ifRecorded = async (
    id: string,
    act: () => Promise<void>
  ): Promise<void> => {
    if ((await containers.get(id)) !== undefined) {
      await act();
    }
  };
  const versions = createModuleVersions({ artifacts, store });
  const invocations = createModuleGatewayRuntimeDispatcher({
    ...(options.authorization === undefined
      ? {}
      : { authorization: options.authorization }),
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
    removeContainer: (id) => ifRecorded(id, () => containers.remove(id)),
    runtime: createContainerModuleProgramRuntime({
      ...(options.authorization === undefined
        ? {}
        : { authorization: options.authorization }),
      checkouts: options.checkouts,
      containers,
      store,
      transport: options.transport,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    stopRetainedContainer: (id) => ifRecorded(id, () => containers.stop(id)),
    store,
    versions,
    ...(options.onSettledTransition === undefined
      ? {}
      : { onSettledTransition: options.onSettledTransition }),
  });
  return Object.freeze({
    gateway,
    invocations,
    modules: createModuleManagement({
      artifacts,
      programs,
      providers: options.providers,
      store,
    }),
    programs,
    recovery: createModuleRuntimeRecovery({ store, supervisor: programs }),
  });
}

export type ModulePlatform = ReturnType<typeof createModulePlatform>;
