import { createModuleAccess, installationPrincipal } from "../access";
import type { Installation, InstallationId, ModuleVersion } from "../domain";
import type {
  ModuleCapabilityProvider,
  ModuleGatewayRuntimeDispatcher,
  ModuleRuntimeIdentity,
} from "../gateway/types";
import {
  type ActivationCompatibilityFact,
  type ActivationPreflight,
  preflightModuleActivation,
} from "../preflight";
import type {
  ModuleSettingsHostPolicy,
  ModuleSettingValues,
} from "../settings";
import type { ModuleStore } from "../store/contract";
import { ModuleStoreConflictError } from "../store/contract";
import type { ModuleProgramLaunch, ModuleProgramSupervisor } from "./contracts";
import type { ModuleSelectedCheckouts } from "./files";

/**
 * Activating Installations on demand, in the order that keeps authority
 * and files consistent: select the Version (Grants carried over, files
 * swapped), preflight against the Grants that survived, then start at the
 * generation the selection produced. The supervisor owns every transition;
 * which Installation a host keeps per Module, what a Program is allocated
 * and where each step runs are the host's.
 */
export interface ModuleInstallations {
  /**
   * Moves a stopped Installation to `version`. Grants whose request changed
   * are revoked before the selection is recorded, so a failed selection can
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
   * host's settings, then starts its Program at `installation`'s
   * generation. Throws {@link ModuleActivationRefusedError} when a blocking
   * fact refuses it, before anything is acquired.
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
  /** Stops the Installation's Program at its current generation; nothing when it is gone. */
  stop(input: {
    readonly installationId: InstallationId;
    readonly reason: string;
  }): Promise<void>;
}

/** A Version that may not start here: each blocking fact says why. */
export class ModuleActivationRefusedError extends Error {
  override readonly name = "ModuleActivationRefusedError";
  readonly facts: readonly ActivationCompatibilityFact[];

  constructor(facts: readonly ActivationCompatibilityFact[]) {
    super(
      `The Version cannot start: ${facts.map((fact) => fact.detail).join("; ")}`
    );
    this.facts = facts;
  }
}

export interface CreateModuleInstallationsOptions {
  /** A selected checkout swaps on selection; digest-named checkouts need not. */
  readonly checkouts?: Partial<Pick<ModuleSelectedCheckouts, "select">>;
  /** Cancels Invocations under Grants a Version change drops. */
  readonly invocations?: Pick<ModuleGatewayRuntimeDispatcher, "revoke">;
  readonly programs: Pick<
    ModuleProgramSupervisor,
    "selectVersion" | "start" | "stop"
  >;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly store: ModuleStore;
}

export function createModuleInstallations(
  options: CreateModuleInstallationsOptions
): ModuleInstallations {
  const { checkouts, programs, providers, store } = options;
  const access = createModuleAccess({
    ...(options.invocations === undefined
      ? {}
      : { invocations: options.invocations }),
    providers,
    store,
  });

  return Object.freeze({
    async selectVersion({
      installation,
      version,
      signal,
    }: Parameters<ModuleInstallations["selectVersion"]>[0]) {
      const requests = await access.requests({ installation, version });
      const record = async () => {
        await access.carryOver({
          expectedGeneration: installation.generation,
          installationId: installation.id,
          requests,
        });
        return programs.selectVersion({
          contentId: version.contentId,
          expectedGeneration: installation.generation,
          installationId: installation.id,
        });
      };
      return checkouts?.select
        ? checkouts.select(version, record, signal)
        : record();
    },
    async start({
      installation,
      version,
      launch,
      settings,
      signal,
    }: Parameters<ModuleInstallations["start"]>[0]) {
      const context = await store.loadGatewayContext(installation.id);
      if (
        !context ||
        context.installation.generation !== installation.generation ||
        context.installation.contentId !== version.contentId
      ) {
        throw new ModuleStoreConflictError(
          `Installation ${installation.id} no longer selects Content ${version.contentId} at generation ${installation.generation}`
        );
      }
      const preflight = await preflightModuleActivation({
        grants: context.grants,
        principal: installationPrincipal(installation, version),
        providers,
        settings,
        version,
      });
      const blocking = preflight.facts.filter((fact) => fact.blocking);
      if (blocking.length > 0) {
        throw new ModuleActivationRefusedError(blocking);
      }
      signal?.throwIfAborted();
      const runtime = await programs.start({
        expectedGeneration: installation.generation,
        installationId: installation.id,
        launch,
        ...(signal === undefined ? {} : { signal }),
      });
      return { preflight, runtime };
    },
    async stop({
      installationId,
      reason,
    }: Parameters<ModuleInstallations["stop"]>[0]) {
      const current = await store.loadGatewayContext(installationId);
      if (current) {
        await programs.stop({
          expectedGeneration: current.installation.generation,
          installationId,
          reason,
        });
      }
    },
  });
}
