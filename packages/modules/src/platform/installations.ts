import { createModuleAccess } from "../access";
import type { Installation, InstallationId, ModuleVersion } from "../domain";
import type {
  ModuleCapabilityProvider,
  ModuleGatewayRuntimeDispatcher,
  ModuleRuntimeIdentity,
} from "../gateway/types";
import type { ActivationPreflight } from "../preflight";
import type {
  ModuleSettingsHostPolicy,
  ModuleSettingValues,
} from "../settings";
import type { ModuleStore } from "../store/contract";
import type { ModuleProgramLaunch, ModuleProgramSupervisor } from "./contracts";
import type { ModuleSelectedCheckouts } from "./files";

// biome-ignore lint/performance/noBarrelFile: Preserve the facade's existing public error identity while activation owns its policy.
export { ModuleActivationRefusedError } from "./activation";

/**
 * Activating Installations on demand, in the order that keeps authority
 * and files consistent: select the Version (Grants carried over, files
 * swapped), preflight against the Grants that survived, then start at the
 * generation the selection produced. The supervisor owns ordering and every transition; which
 * Installation a host keeps per Module, what a Program is allocated and
 * where each step runs are the host's.
 */
export interface ModuleInstallations {
  /**
   * Moves a stopped Installation to `version`; one that is not stopped is
   * refused before anything changes. Grants whose request changed are
   * revoked before the selection is recorded, so a failed selection can
   * lose authority but never gain it; a selected checkout swaps in first
   * and is put back if the record fails.
   */
  selectVersion(input: {
    readonly installation: Installation;
    readonly version: ModuleVersion;
    readonly signal?: AbortSignal;
  }): Promise<Installation>;
  /**
   * Preflights `version` against the Installation's current Grants and the
   * host's settings, checks launch persistence and resources against the
   * Manifest and host's ceilings, then starts its Program at
   * `installation`'s generation. Throws {@link ModuleActivationRefusedError}
   * when a blocking fact refuses it, before anything is acquired.
   */
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
  /**
   * Stops the Installation's Program at the generation current once calls
   * made before it are done; nothing when it is gone.
   */
  stop(input: {
    readonly installationId: InstallationId;
    readonly reason: string;
  }): Promise<void>;
}

export interface CreateModuleInstallationsOptions {
  /** A selected checkout swaps on selection; digest-named checkouts need not. */
  readonly checkouts?: Partial<Pick<ModuleSelectedCheckouts, "select">>;
  /** Cancels Invocations under Grants a Version change drops. */
  readonly invocations?: Pick<ModuleGatewayRuntimeDispatcher, "revoke">;
  readonly programs: Pick<
    ModuleProgramSupervisor,
    "selectVersion" | "activate" | "stop"
  >;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly store: ModuleStore;
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
