import type { InstallationId, ModuleVersion } from "../domain";

export interface ModuleCheckouts {
  /** Returns verified, immutable executable files suitable for a read-only mount. */
  ensure(input: {
    readonly version: Pick<ModuleVersion, "contentId" | "digest">;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly hostPath: string }>;
}

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
    readonly signal?: AbortSignal;
  }): Promise<PreparedInstallationFiles>;
  release(installationId: InstallationId): Promise<void>;
  /** Restores the baseline without consuming it; false if none was recorded. */
  restoreBackup(installationId: InstallationId): Promise<boolean>;
}
