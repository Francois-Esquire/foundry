import { createModuleAccess, installationPrincipal } from "../access";
import type { Installation, InstallationId, ModuleVersion } from "../domain";
import type {
  ModuleCapabilityProvider,
  ModuleGatewayRuntimeDispatcher,
  ModuleRuntimeIdentity,
} from "../gateway/types";
import { isStrictModuleManifest, moduleSettingRequests } from "../manifest";
import {
  type ActivationCompatibilityFact,
  type ActivationPreflight,
  preflightModuleActivation,
} from "../preflight";
import {
  type ModuleSettingsHostPolicy,
  type ModuleSettingValues,
  resolveModuleSettings,
} from "../settings";
import type { ModuleStore } from "../store/contract";
import { ModuleStoreConflictError } from "../store/contract";
import type { ModuleProgramLaunch, ModuleProgramSupervisor } from "./contracts";
import type { ModuleSelectedCheckouts } from "./files";
import { KeyedTurns } from "./turns";

/**
 * Activating Installations on demand, in the order that keeps authority
 * and files consistent: select the Version (Grants carried over, files
 * swapped), preflight against the Grants that survived, then start at the
 * generation the selection produced. Calls for one Installation run one at
 * a time, in call order. The supervisor owns every transition; which
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

  /** One call per Installation at a time, so each sees the last one's result. */
  const turns = new KeyedTurns<InstallationId>();

  return Object.freeze({
    selectVersion({
      installation,
      version,
      signal,
    }: Parameters<ModuleInstallations["selectVersion"]>[0]) {
      return turns.run(installation.id, async () => {
        const requests = await access.requests({ installation, version });
        const record = async (select: () => Promise<Installation>) => {
          await access.carryOver({
            expectedGeneration: installation.generation,
            installationId: installation.id,
            requests,
          });
          return select();
        };
        // Inside the supervisor's turn, after it refused an Installation
        // that is not stopped: nothing is revoked or swapped for a selection
        // that cannot proceed, and the checkout's Module turn is always
        // taken after the Installation's, as a start takes it.
        return programs.selectVersion({
          around: (select) =>
            checkouts?.select
              ? checkouts.select(version, () => record(select), signal)
              : record(select),
          contentId: version.contentId,
          expectedGeneration: installation.generation,
          installationId: installation.id,
        });
      });
    },
    start({
      installation,
      version,
      launch,
      settings,
      signal,
    }: Parameters<ModuleInstallations["start"]>[0]) {
      return turns.run(installation.id, async () => {
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
        const blocking = [
          ...preflight.facts.filter((fact) => fact.blocking),
          ...unmetLaunchRequirements({ launch, settings, version }),
        ];
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
      });
    },
    stop({
      installationId,
      reason,
    }: Parameters<ModuleInstallations["stop"]>[0]) {
      return turns.run(installationId, async () => {
        if (await store.loadGatewayContext(installationId)) {
          // The supervisor reads the generation in its own turn, so a start
          // queued there first is the one stopped.
          await programs.stop({ installationId, reason });
        }
      });
    },
  });
}

/**
 * Launch choices the Module or host refuses: persistence must match the
 * Manifest, and resources must meet its minimums and the host's ceilings.
 */
function unmetLaunchRequirements(input: {
  readonly launch: ModuleProgramLaunch;
  readonly settings: Parameters<ModuleInstallations["start"]>[0]["settings"];
  readonly version: ModuleVersion;
}): ActivationCompatibilityFact[] {
  const { resources } = input.launch;
  const { manifest } = input.version;
  const persistence = isStrictModuleManifest(manifest)
    ? manifest.persistence?.files
    : undefined;
  const requiredPersistence =
    persistence ?? (manifest.data === undefined ? undefined : "installation");
  const facts: ActivationCompatibilityFact[] = [];
  if (
    requiredPersistence !== undefined &&
    input.launch.files !== requiredPersistence
  ) {
    facts.push({
      blocking: true,
      detail: `The launch uses private files persistence "${input.launch.files}"; the Module requires "${requiredPersistence}"`,
      kind: "unsupported-requirement",
    });
  }
  const resolution = resolveModuleSettings({
    policy: input.settings.policy,
    requests: moduleSettingRequests(input.version.manifest),
    user: {
      ...input.settings.user,
      "resources.cpus": resources.cpus,
      "resources.memoryBytes": resources.memoryBytes,
    },
  });
  if (resolution.ok) {
    return facts;
  }
  return [
    ...facts,
    ...resolution.problems
      .filter(
        (problem) =>
          problem.key === "resources.cpus" ||
          problem.key === "resources.memoryBytes"
      )
      .map((problem) => ({
        blocking: true,
        detail: `Launch ${problem.message}`,
        kind: "unsupported-requirement" as const,
      })),
  ];
}
