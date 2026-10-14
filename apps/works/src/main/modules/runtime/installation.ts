import {
  type Installation,
  type InstallationId,
  installationIdSchema,
  type ModuleVersion,
} from "@foundry/modules/domain";
import type { ModuleConstraintsPrincipal } from "@foundry/modules/gateway/types";
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
  const id = moduleInstallationId(version.moduleId);
  return store.transaction(async () => {
    const context = await store.loadGatewayContext(id);
    return (
      context?.installation ??
      (await store.createInstallation({ id, now, version }))
    );
  });
}

/** Who a provider resolves constraints for, before a Program exists. */
export function installationPrincipal(
  installation: Pick<Installation, "generation" | "id" | "moduleId">,
  version: Pick<ModuleVersion, "contentId">
): ModuleConstraintsPrincipal {
  return {
    contentId: version.contentId,
    generation: installation.generation,
    installationId: installation.id,
    moduleId: installation.moduleId,
  };
}
