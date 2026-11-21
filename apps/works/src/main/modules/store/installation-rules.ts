import { byCodeUnit } from "@foundry/lib/ordering";
import type {
  Installation,
  InstallationId,
  Module,
} from "@foundry/modules/domain";
import { createDisabledInstallation } from "@foundry/modules/domain";
import {
  ModuleStoreConflictError,
  ModuleStoreNotFoundError,
} from "@foundry/modules/errors";
import type {
  BeginInstallationTransitionInput,
  CreateInstallationInput,
  InstallationGrant,
  ReplaceInstallationGrantsInput,
  RevokeInstallationGrantInput,
  SelectInstallationVersionInput,
  SetInstallationContainerIdInput,
  SettleInstallationStatusInput,
} from "@foundry/modules/registry";

export interface StoredInstallation {
  readonly grants: readonly InstallationGrant[];
  readonly installation: Installation;
}

export interface InstallationChange<Result> {
  readonly next: StoredInstallation;
  readonly result: Result;
}

export interface InstallationTarget {
  readonly expectedGeneration: number;
  readonly installationId: InstallationId;
}

export type InstallationRule<Result> = (
  stored: StoredInstallation
) => InstallationChange<Result>;

export function atGeneration(
  stored: StoredInstallation | undefined,
  installationId: InstallationId,
  expectedGeneration: number
): StoredInstallation {
  if (stored === undefined) {
    throw new ModuleStoreNotFoundError(installationId);
  }
  const { generation } = stored.installation;
  if (generation !== expectedGeneration) {
    throw new ModuleStoreConflictError(
      `Installation ${installationId} generation is ${generation}, not ${expectedGeneration}`
    );
  }
  return stored;
}

export function newInstallation(
  input: CreateInstallationInput
): StoredInstallation {
  return { grants: [], installation: createDisabledInstallation(input) };
}

export function setContainer(
  input: SetInstallationContainerIdInput
): InstallationRule<Installation> {
  return (stored) =>
    patched(stored, { containerId: input.containerId, updatedAt: input.now });
}

export function beginTransition(
  input: BeginInstallationTransitionInput
): InstallationRule<Installation> {
  return (stored) =>
    patched(stored, {
      generation: stored.installation.generation + 1,
      status: input.status,
      ...(input.resetStartAttempts === true ? { startAttempts: 0 } : {}),
      updatedAt: input.now,
    });
}

export function settle(
  input: SettleInstallationStatusInput
): InstallationRule<Installation> {
  return (stored) =>
    patched(stored, {
      startAttempts: settledStartAttempts(
        input.status,
        stored.installation.startAttempts
      ),
      status: input.status,
      updatedAt: input.now,
    });
}

function settledStartAttempts(
  status: SettleInstallationStatusInput["status"],
  startAttempts: number
): number {
  if (status === "active") {
    return 0;
  }
  if (status === "failed") {
    return startAttempts + 1;
  }
  return startAttempts;
}

export function selectVersion(
  input: SelectInstallationVersionInput
): InstallationRule<Installation> {
  return (stored) => {
    if (stored.installation.moduleId !== input.version.moduleId) {
      throw new ModuleStoreConflictError(
        `Content ${input.version.contentId} does not belong to Installation ${stored.installation.id}'s Module`
      );
    }
    return patched(stored, {
      contentId: input.version.contentId,
      generation: stored.installation.generation + 1,
      startAttempts: 0,
      updatedAt: input.now,
    });
  };
}

export function replaceGrants(
  input: ReplaceInstallationGrantsInput
): InstallationRule<readonly InstallationGrant[]> {
  return (stored) => {
    const capabilities = new Set<string>();
    for (const grant of input.grants) {
      if (capabilities.has(grant.capability)) {
        throw new ModuleStoreConflictError(
          `Grant capability ${grant.capability} is duplicated`
        );
      }
      capabilities.add(grant.capability);
    }
    const grants = input.grants
      .map((grant) => copyGrant({ ...grant, createdAt: new Date(input.now) }))
      .sort(byCodeUnit((grant) => grant.capability));
    return { next: { ...stored, grants }, result: grants.map(copyGrant) };
  };
}

export function revokeGrant(
  input: RevokeInstallationGrantInput
): InstallationRule<InstallationGrant> {
  return (stored) => {
    const revoked = stored.grants.find(
      (grant) => grant.capability === input.capability
    );
    if (revoked === undefined) {
      throw new ModuleStoreConflictError(
        `Installation ${input.installationId} has no grant for ${input.capability}`
      );
    }
    return {
      next: {
        ...stored,
        grants: stored.grants.filter((grant) => grant !== revoked),
      },
      result: copyGrant(revoked),
    };
  };
}

function patched(
  stored: StoredInstallation,
  patch: Partial<Installation>
): InstallationChange<Installation> {
  const installation = copyInstallation({ ...stored.installation, ...patch });
  return {
    next: { ...stored, installation },
    result: copyInstallation(installation),
  };
}

export function copyModule(value: Module): Module {
  return Object.freeze({ artifactId: value.artifactId, id: value.id });
}

export function copyInstallation(value: Installation): Installation {
  return Object.freeze({
    containerId: value.containerId,
    contentId: value.contentId,
    createdAt: new Date(value.createdAt),
    generation: value.generation,
    id: value.id,
    moduleId: value.moduleId,
    startAttempts: value.startAttempts,
    status: value.status,
    updatedAt: new Date(value.updatedAt),
  });
}

export function copyGrant(value: InstallationGrant): InstallationGrant {
  return Object.freeze({
    capability: value.capability,
    constraintsDigest: value.constraintsDigest,
    createdAt: new Date(value.createdAt),
    version: value.version,
  });
}
