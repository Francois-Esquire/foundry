import { createModuleAccess } from "../access";
import type { Installation, InstallationId, ModuleVersion } from "../domain";
import type {
  ModuleCapabilityProvider,
  ModuleGatewayRuntimeDispatcher,
  ModuleRuntimeIdentity,
} from "../gateway/types";
import type { ActivationPreflight } from "../preflight";
import type { ModuleCommands } from "../registry";
import type {
  ModuleSettingsHostPolicy,
  ModuleSettingValues,
} from "../settings";
import type { ModuleProgramLaunch, ModuleProgramSupervisor } from "./contracts";
import type { ModuleSelectedCheckouts } from "./files";

// biome-ignore lint/performance/noBarrelFile: Preserve the facade's existing public error identity while activation owns its policy.
export { ModuleActivationRefusedError } from "./activation";

export interface ModuleInstallations {
  selectVersion(input: {
    readonly installation: Installation;
    readonly version: ModuleVersion;
    readonly signal?: AbortSignal;
  }): Promise<Installation>;
  start(input: {
    readonly installation: Installation;
    readonly version: ModuleVersion;
    readonly launch: ModuleProgramLaunch;
    readonly settings: {
      readonly policy: ModuleSettingsHostPolicy;
      readonly user: ModuleSettingValues;
    };
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly preflight: ActivationPreflight;
    readonly runtime: ModuleRuntimeIdentity;
  }>;
  stop(input: {
    readonly installationId: InstallationId;
    readonly reason: string;
  }): Promise<void>;
}

export interface CreateModuleInstallationsOptions {
  readonly checkouts?: Partial<Pick<ModuleSelectedCheckouts, "select">>;
  readonly invocations?: Pick<ModuleGatewayRuntimeDispatcher, "revoke">;
  readonly programs: Pick<
    ModuleProgramSupervisor,
    "selectVersion" | "activate" | "stop"
  >;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly store: ModuleCommands;
}

export function createModuleInstallations(
  options: CreateModuleInstallationsOptions
): ModuleInstallations {
  const access = createModuleAccess(options);
  return Object.freeze({
    selectVersion({
      installation,
      version,
      signal,
    }: Parameters<ModuleInstallations["selectVersion"]>[0]) {
      return options.programs.selectVersion({
        contentId: version.contentId,
        expectedGeneration: installation.generation,
        installationId: installation.id,
        selection: {
          access,
          ...(options.checkouts === undefined
            ? {}
            : { checkouts: options.checkouts }),
        },
        ...(signal === undefined ? {} : { signal }),
      });
    },
    start(input: Parameters<ModuleInstallations["start"]>[0]) {
      return options.programs.activate({
        ...input,
        providers: options.providers,
      });
    },
    stop(input: Parameters<ModuleInstallations["stop"]>[0]) {
      return options.programs.stop(input);
    },
  });
}
