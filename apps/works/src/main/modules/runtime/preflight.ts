import type { ModuleVersion } from "@foundry/modules/domain";
import { moduleSettingRequests } from "@foundry/modules/manifest";
import {
  type ActivationCompatibilityFact,
  unsupportedModuleRequirements,
} from "@foundry/modules/preflight";
import {
  type ModuleSettingValues,
  requireModuleSettings,
} from "@foundry/modules/settings";
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
 * Why a release cannot start, in Works' words: each blocking fact, and
 * where to approve a Capability the user has not approved yet.
 */
export function releaseRefusal(
  blocking: readonly ActivationCompatibilityFact[]
): ModuleRuntimeError {
  const approval = blocking.some((fact) => fact.kind === "ungranted-capability")
    ? " Approve it in the Module's Access panel, then open the app again."
    : "";
  return new ModuleRuntimeError(
    `This release cannot start: ${blocking.map((fact) => fact.detail).join("; ")}.${approval}`
  );
}

function refuse(facts: readonly ActivationCompatibilityFact[]): void {
  const blocking = facts.filter((fact) => fact.blocking);
  if (blocking.length > 0) {
    throw releaseRefusal(blocking);
  }
}
