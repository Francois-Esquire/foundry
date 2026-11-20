import type { InstallationId, ModuleVersion } from "../domain";

export interface ModuleCheckouts {
  ensure(input: {
    readonly version: Pick<ModuleVersion, "contentId" | "digest" | "moduleId">;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly hostPath: string }>;
}

export interface ModuleSelectedCheckouts extends ModuleCheckouts {
  select<T>(
    version: Pick<ModuleVersion, "contentId" | "digest" | "moduleId">,
    record: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T>;
}

export type ModuleFilesPersistence = "installation" | "none";

export interface PreparedInstallationFiles {
  readonly hostPath: string;
  readonly installationId: InstallationId;
}

export interface ModuleInstallationFiles {
  backup(installationId: InstallationId): Promise<void>;
  delete(installationId: InstallationId): Promise<void>;
  discardBackup(installationId: InstallationId): Promise<void>;
  prepare(input: {
    readonly installationId: InstallationId;
    readonly persistence: ModuleFilesPersistence;
    readonly signal?: AbortSignal;
  }): Promise<PreparedInstallationFiles>;
  release(installationId: InstallationId): Promise<void>;
  restoreBackup(installationId: InstallationId): Promise<boolean>;
}
