import {
  type Installation,
  type InstallationId,
  installationIdSchema,
  type ModuleVersion,
} from "@foundry/modules/domain";
import { ensureInstallation } from "@foundry/modules/management";
import type { ModuleStore } from "@foundry/modules/store/contract";

/**
 * A Module's one durable Installation is named after the Module, so its
 * identity (and its private files) can be found without a lookup table.
 */
export function moduleInstallationId(moduleId: string): InstallationId {
  return installationIdSchema.parse(moduleId);
}

/** The Module's Installation, created disabled at `version` when it has none. */
export function ensureModuleInstallation(
  store: ModuleStore,
  version: ModuleVersion,
  now: Date
): Promise<Installation> {
  return ensureInstallation({
    installationId: moduleInstallationId(version.moduleId),
    now,
    store,
    version,
  });
}
