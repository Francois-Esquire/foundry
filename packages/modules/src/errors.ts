import type { InstallationId } from "./domain";

/** A change the registry refuses against what the store holds now. */
export class ModuleStoreConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModuleStoreConflictError";
  }
}

export class ModuleStoreNotFoundError extends Error {
  readonly installationId: InstallationId;

  constructor(installationId: InstallationId) {
    super(`Installation ${installationId} was not found`);
    this.installationId = installationId;
    this.name = "ModuleStoreNotFoundError";
  }
}

/**
 * A call that writes its Artifact and the registry in two commits, made
 * inside a caller's Artifact transaction. Its Artifact write would then
 * commit only with the caller's, after the registry's, and a rollback there
 * would leave the registry naming an Artifact that does not exist.
 */
export class ModuleCrossStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModuleCrossStoreError";
  }
}
