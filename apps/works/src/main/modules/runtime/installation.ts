import {
  type Installation,
  type InstallationId,
  installationIdSchema,
  type ModuleVersion,
} from "@foundry/modules/domain";
import { ensureInstallation } from "@foundry/modules/management";
import type { ModuleCommands } from "@foundry/modules/registry";

export function moduleInstallationId(moduleId: string): InstallationId {
  return installationIdSchema.parse(moduleId);
}

export function ensureModuleInstallation(
  store: ModuleCommands,
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
