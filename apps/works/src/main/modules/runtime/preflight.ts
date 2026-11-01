import type { ModuleVersion } from "@foundry/modules/domain";
import type {
  ModuleCapabilityProvider,
  ModuleConstraintsPrincipal,
} from "@foundry/modules/gateway/types";
import { moduleSettingRequests } from "@foundry/modules/manifest";
import {
  type ActivationCompatibilityFact,
  type ActivationPreflight,
  preflightModuleActivation,
  unsupportedModuleRequirements,
} from "@foundry/modules/preflight";
import {
  type ModuleSettingValues,
  requireModuleSettings,
} from "@foundry/modules/settings";
import type { InstallationGrant } from "@foundry/modules/store/contract";
import {
  PROGRAM_SETTINGS_POLICY,
  type SandboxResources,
  sandboxResources,
} from "../settings";
import { ModuleRuntimeError } from "./controller";

/**
 * What a released Program starts with, checked before anything is
 * acquired: requirements this host cannot meet (a hard storage limit, a
 * minimum above a ceiling, a user value below a minimum) refuse the start.
 */
export function programResources(
  version: Pick<ModuleVersion, "manifest">,
  user: ModuleSettingValues
): SandboxResources {
  refuse(
    unsupportedModuleRequirements({
      manifest: version.manifest,
      settings: { policy: PROGRAM_SETTINGS_POLICY, user },
    })
  );
  return sandboxResources(
    requireModuleSettings({
      policy: PROGRAM_SETTINGS_POLICY,
      requests: moduleSettingRequests(version.manifest),
      user,
    })
  );
}

/**
 * The Capability half of preflight, once the Installation exists and before
 * its Program starts: a required Capability the host does not provide,
 * denies, or the user has not approved in Access refuses the start; an
 * optional one leaves that feature off.
 */
export async function preflightRelease(input: {
  readonly version: Pick<ModuleVersion, "manifest">;
  readonly user: ModuleSettingValues;
  readonly principal: ModuleConstraintsPrincipal;
  readonly grants: readonly InstallationGrant[];
  readonly providers: readonly ModuleCapabilityProvider[];
}): Promise<ActivationPreflight> {
  const report = await preflightModuleActivation({
    grants: input.grants,
    principal: input.principal,
    providers: input.providers,
    settings: { policy: PROGRAM_SETTINGS_POLICY, user: input.user },
    version: input.version,
  });
  refuse(report.facts);
  return report;
}

function refuse(facts: readonly ActivationCompatibilityFact[]): void {
  const blocking = facts.filter((fact) => fact.blocking);
  if (blocking.length > 0) {
    const approval = blocking.some(
      (fact) => fact.kind === "ungranted-capability"
    )
      ? " Approve it in the Module's Access panel, then open the app again."
      : "";
    throw new ModuleRuntimeError(
      `This release cannot start: ${blocking.map((fact) => fact.detail).join("; ")}.${approval}`
    );
  }
}
