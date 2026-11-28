import { covers, type Grant } from "@foundry/authorization";
import { byCodeUnit } from "@foundry/lib/ordering";
import type { Installation, InstallationId, ModuleVersion } from "./domain";
import { ModuleStoreConflictError } from "./errors";
import type {
  ModuleCapabilityProvider,
  ModuleConstraintsPrincipal,
  ModuleGatewayRuntimeDispatcher,
} from "./gateway/types";
import {
  grantToInstallationGrant,
  installationGrantsFrom,
  MODULE_CAPABILITY_ACTION,
  MODULE_HOST_PRINCIPAL,
  type ModuleAccessRequest,
  moduleAccessRequests,
  moduleCapabilityAccessRequest,
  moduleCapabilityScope,
  moduleInstallationPrincipal,
} from "./grants";
import type { InstallationGrant, ModuleUnit } from "./modules";

export class ModuleAccessError extends Error {
  override readonly name = "ModuleAccessError";
}

type InstallationRef = Pick<Installation, "generation" | "id" | "moduleId">;

export interface ModuleAccess {
  approve(input: {
    readonly installation: InstallationRef & Pick<Installation, "contentId">;
    readonly version: ModuleVersion;
    readonly capability: string;
  }): Promise<{
    readonly grants: readonly InstallationGrant[];
    readonly request: ModuleAccessRequest;
  }>;
  carryOver(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly requests: readonly ModuleAccessRequest[];
  }): Promise<readonly InstallationGrant[]>;
  requests(input: {
    readonly installation: InstallationRef;
    readonly version: ModuleVersion;
  }): Promise<readonly ModuleAccessRequest[]>;
  revoke(input: {
    readonly installationId: InstallationId;
    readonly capability: string;
  }): Promise<InstallationGrant>;
}

export interface CreateModuleAccessOptions {
  readonly invocations?: Pick<ModuleGatewayRuntimeDispatcher, "revoke">;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly store: AccessRegistry;
}

export type AccessRegistry = ModuleUnit<"authorization" | "loadGatewayContext">;

export function installationPrincipal(
  installation: InstallationRef,
  version: Pick<ModuleVersion, "contentId">
): ModuleConstraintsPrincipal {
  return {
    contentId: version.contentId,
    generation: installation.generation,
    installationId: installation.id,
    moduleId: installation.moduleId,
  };
}

export function createModuleAccess(
  options: CreateModuleAccessOptions
): ModuleAccess {
  const { providers, store } = options;
  if (store.durability === "host") {
    throw new TypeError(
      'createModuleAccess cannot run over a registry whose commits a host transaction may roll back (durability "host"), such as the registry a transaction hands its work: it cancels Invocations once a revoke commits, and a rollback would restore the Grant. Run it over a registry on the store itself.'
    );
  }

  function requests(input: {
    readonly installation: InstallationRef;
    readonly version: ModuleVersion;
  }) {
    return moduleAccessRequests({
      principal: installationPrincipal(input.installation, input.version),
      providers,
      version: input.version,
    });
  }

  function cancel(
    installationId: InstallationId,
    capability: string
  ): Promise<void> {
    options.invocations?.revoke({
      capability,
      installationId,
      reason: "The Grant was revoked",
    });
    return Promise.resolve();
  }

  return Object.freeze({
    async approve({
      installation,
      version,
      capability,
    }: Parameters<ModuleAccess["approve"]>[0]) {
      const request = (await requests({ installation, version })).find(
        (candidate) => candidate.capability === capability
      );
      if (!request) {
        throw new ModuleAccessError(
          `Version ${version.tag} does not request ${capability}`
        );
      }
      const { constraintsDigest } = request;
      if (constraintsDigest === null) {
        throw new ModuleAccessError(
          `This host cannot provide ${capability}, so it cannot be approved`
        );
      }
      const principal = moduleInstallationPrincipal(installation.id);
      const grants = await store.transaction(async (registry, effects) => {
        const current = await registry.loadGatewayContext(installation.id);
        if (
          !current ||
          current.installation.contentId !== version.contentId ||
          current.installation.generation !== installation.generation
        ) {
          throw new ModuleAccessError(
            "The Installation changed while approving; review its requests again"
          );
        }
        const existing = await registry.authorization.listGrants({
          action: MODULE_CAPABILITY_ACTION,
          principal,
          state: "active",
        });
        for (const grant of existing) {
          const projected = grantToInstallationGrant(grant);
          if (projected?.capability === capability) {
            await registry.authorization.revoke(
              { grantId: grant.id, kind: "grant" },
              { effects, reason: "Replaced by a newer approval" }
            );
          }
        }
        await registry.authorization.grant({
          effects,
          holder: { kind: "exact", principal },
          reason: request.reason,
          requestedBy: MODULE_HOST_PRINCIPAL,
          scope: moduleCapabilityScope({
            capability,
            constraintsDigest,
            version: request.version,
          }),
        });
        return installationGrantsFrom(
          await registry.authorization.listGrants({
            action: MODULE_CAPABILITY_ACTION,
            principal,
            state: "active",
          })
        );
      });
      return { grants, request };
    },
    async carryOver({
      installationId,
      expectedGeneration,
      requests: wanted,
    }: Parameters<ModuleAccess["carryOver"]>[0]) {
      const principal = moduleInstallationPrincipal(installationId);
      return await store.transaction(async (registry, effects) => {
        const context = await registry.loadGatewayContext(installationId);
        if (!context) {
          throw new ModuleAccessError(
            `Installation ${installationId} is missing`
          );
        }
        if (context.installation.generation !== expectedGeneration) {
          throw new ModuleStoreConflictError(
            `Installation ${installationId} changed while carrying over Grants`
          );
        }
        const active = await registry.authorization.listGrants({
          action: MODULE_CAPABILITY_ACTION,
          principal,
          state: "active",
        });
        const { dropped, kept } = partitionCarryOverGrants(
          active,
          wanted,
          installationId
        );
        for (const item of dropped) {
          await registry.authorization.revoke(
            { grantId: item.grant.id, kind: "grant" },
            { effects, reason: "The Grant was revoked" }
          );
          if (options.invocations !== undefined) {
            effects.afterCommit(() => cancel(installationId, item.capability));
          }
        }
        return installationGrantsFrom(kept);
      });
    },
    requests,
    async revoke({
      installationId,
      capability,
    }: Parameters<ModuleAccess["revoke"]>[0]) {
      const principal = moduleInstallationPrincipal(installationId);
      return await store.transaction(async (registry, effects) => {
        const current = await registry.loadGatewayContext(installationId);
        if (!current) {
          throw new ModuleAccessError(`${capability} is not approved`);
        }
        const active = await registry.authorization.listGrants({
          action: MODULE_CAPABILITY_ACTION,
          principal,
          state: "active",
        });
        const matched = active
          .map((grant) => ({
            grant,
            projected: grantToInstallationGrant(grant),
          }))
          .filter(
            (
              entry
            ): entry is {
              readonly grant: Grant;
              readonly projected: InstallationGrant;
            } => entry.projected?.capability === capability
          );
        const [first] = matched;
        if (first === undefined) {
          throw new ModuleAccessError(`${capability} is not approved`);
        }
        for (const entry of matched) {
          await registry.authorization.revoke(
            { grantId: entry.grant.id, kind: "grant" },
            { effects, reason: "The Grant was revoked" }
          );
        }
        if (options.invocations !== undefined) {
          effects.afterCommit(() => cancel(installationId, capability));
        }
        return first.projected;
      });
    },
  });
}

function partitionCarryOverGrants(
  active: readonly Grant[],
  wanted: readonly ModuleAccessRequest[],
  installationId: InstallationId
): {
  readonly dropped: readonly {
    readonly capability: string;
    readonly grant: Grant;
  }[];
  readonly kept: readonly Grant[];
} {
  const kept: Grant[] = [];
  const dropped: { readonly capability: string; readonly grant: Grant }[] = [];
  for (const grant of active) {
    const projected = grantToInstallationGrant(grant);
    if (projected === null) {
      continue;
    }
    const matchesWanted = wanted.some(
      (request) =>
        request.constraintsDigest !== null &&
        covers(
          grant.scope,
          moduleCapabilityAccessRequest({
            capability: request.capability,
            constraintsDigest: request.constraintsDigest,
            installationId,
            version: request.version,
          }),
          "allow"
        )
    );
    if (matchesWanted) {
      kept.push(grant);
    } else {
      dropped.push({ capability: projected.capability, grant });
    }
  }
  dropped.sort(byCodeUnit((item) => item.capability));
  return { dropped, kept };
}
