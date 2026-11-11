import { StorageApplicationError } from "@foundry/core/storage";

import type { Installation, InstallationId, ModuleVersion } from "./domain";
import type {
  ModuleCapabilityProvider,
  ModuleConstraintsPrincipal,
  ModuleGatewayRuntimeDispatcher,
} from "./gateway/types";
import {
  carriedGrants,
  type ModuleAccessRequest,
  moduleAccessRequests,
} from "./grants";
import type { InstallationGrant, ModuleStore } from "./store/contract";
import { ModuleStoreConflictError } from "./store/contract";

/**
 * Approving and revoking an Installation's Grants. A request grants nothing
 * until it is approved here against the Installation's selected Version;
 * a revoke stops new Invocations under the Grant as soon as it commits and
 * cancels the active ones. Network destinations are different: a running
 * Program keeps the allowlist it started with until it restarts. How
 * approval is asked for, and which
 * Installation a host creates for it, is the host's.
 */
export class ModuleAccessError extends Error {
  override readonly name = "ModuleAccessError";
}

type InstallationRef = Pick<Installation, "generation" | "id" | "moduleId">;

export interface ModuleAccess {
  /** Approves `capability` as `version` requests it, at the Installation's generation. */
  approve(input: {
    readonly installation: InstallationRef & Pick<Installation, "contentId">;
    readonly version: ModuleVersion;
    readonly capability: string;
  }): Promise<{
    readonly grants: readonly InstallationGrant[];
    readonly request: ModuleAccessRequest;
  }>;
  /**
   * Keeps only the Grants `requests` still match (capability, capability
   * version and resolved constraints digest) and revokes the rest, ahead of
   * a Version change. Returns the Grants kept.
   */
  carryOver(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly requests: readonly ModuleAccessRequest[];
  }): Promise<readonly InstallationGrant[]>;
  /** The Version's requests, resolved for the Installation that would hold their Grants. */
  requests(input: {
    readonly installation: InstallationRef;
    readonly version: ModuleVersion;
  }): Promise<readonly ModuleAccessRequest[]>;
  /**
   * Revokes one held Grant and cancels the Invocations admitted under it.
   * A revoked network Grant narrows a running Program's destinations only
   * when it restarts: its sandbox allowlist is read at start.
   */
  revoke(input: {
    readonly installationId: InstallationId;
    readonly capability: string;
  }): Promise<InstallationGrant>;
}

export interface CreateModuleAccessOptions {
  /** Cancels a revoked Grant's active Invocations; none run without it. */
  readonly invocations?: Pick<ModuleGatewayRuntimeDispatcher, "revoke">;
  readonly now?: () => Date;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly store: ModuleStore;
}

/** Who a provider resolves constraints for, before a Program exists. */
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
  const now = options.now ?? (() => new Date());

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
  function cancel(installationId: InstallationId, capability: string) {
    options.invocations?.revoke({
      capability,
      installationId,
      reason: "The Grant was revoked",
    });
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
      const grants = await store.transaction(async () => {
        const current = await store.loadGatewayContext(installation.id);
        if (
          !current ||
          current.installation.contentId !== version.contentId ||
          current.installation.generation !== installation.generation
        ) {
          throw new ModuleAccessError(
            "The Installation changed while approving; review its requests again"
          );
        }
        return store.replaceInstallationGrants({
          expectedGeneration: current.installation.generation,
          grants: [
            ...current.grants.filter(
              (grant) => grant.capability !== capability
            ),
            { capability, constraintsDigest, version: request.version },
          ],
          installationId: installation.id,
          now: now(),
        });
      });
      return { grants, request };
    },
    async carryOver({
      installationId,
      expectedGeneration,
      requests: wanted,
    }: Parameters<ModuleAccess["carryOver"]>[0]) {
      // Read outside the unit, so a commit whose host application then
      // failed still cancels what it revoked.
      let revoked: readonly InstallationGrant[] = [];
      const kept = await committedThen(
        store.transaction(async () => {
          revoked = [];
          const context = await store.loadGatewayContext(installationId);
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
          const carried = carriedGrants(context.grants, wanted);
          const dropped = context.grants.filter(
            (grant) => !carried.includes(grant)
          );
          for (const grant of dropped) {
            await store.revokeInstallationGrant({
              capability: grant.capability,
              expectedGeneration,
              installationId,
            });
          }
          revoked = dropped;
          return carried;
        }),
        () => {
          for (const grant of revoked) {
            cancel(installationId, grant.capability);
          }
        }
      );
      return kept;
    },
    requests,
    revoke({
      installationId,
      capability,
    }: Parameters<ModuleAccess["revoke"]>[0]) {
      return committedThen(
        store.transaction(async () => {
          const current = await store.loadGatewayContext(installationId);
          if (
            !current?.grants.some((grant) => grant.capability === capability)
          ) {
            throw new ModuleAccessError(`${capability} is not approved`);
          }
          return store.revokeInstallationGrant({
            capability,
            expectedGeneration: current.installation.generation,
            installationId,
          });
        }),
        () => cancel(installationId, capability)
      );
    },
  });
}

/**
 * Runs `effect` once `transaction` committed: when it succeeded, and when its
 * records committed but applying them to the host failed. That failure is
 * rethrown as it was; a rolled-back unit runs nothing.
 */
async function committedThen<T>(
  transaction: Promise<T>,
  effect: () => void
): Promise<T> {
  let result: T;
  try {
    result = await transaction;
  } catch (error) {
    if (error instanceof StorageApplicationError) {
      effect();
    }
    throw error;
  }
  effect();
  return result;
}
