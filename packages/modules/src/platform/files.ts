import type { InstallationId, ModuleVersion } from "../domain";

export interface ModuleCheckouts {
  /** Returns verified, immutable executable files suitable for a read-only mount. */
  ensure(input: {
    readonly version: Pick<ModuleVersion, "contentId" | "digest" | "moduleId">;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly hostPath: string }>;
}

/** Whether a Program's private files outlive it, or go when it stops. */
export type ModuleFilesPersistence = "installation" | "none";

export interface PreparedInstallationFiles {
  readonly hostPath: string;
  readonly installationId: InstallationId;
}

export interface ModuleInstallationFiles {
  /** Writers must be stopped; include WAL state and record an absent database. */
  backup(installationId: InstallationId): Promise<void>;
  delete(installationId: InstallationId): Promise<void>;
  discardBackup(installationId: InstallationId): Promise<void>;
  prepare(input: {
    readonly installationId: InstallationId;
    /** The starting Program's persistence; an adapter may keep only one kind. */
    readonly persistence: ModuleFilesPersistence;
    readonly signal?: AbortSignal;
  }): Promise<PreparedInstallationFiles>;
  release(installationId: InstallationId): Promise<void>;
  /** Restores the baseline without consuming it; false if none was recorded. */
  restoreBackup(installationId: InstallationId): Promise<boolean>;
}
