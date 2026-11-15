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
