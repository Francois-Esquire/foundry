import type { InstallationId, ModuleVersion } from "../domain";

export interface ModuleCheckouts {
  /** Returns verified, immutable executable files suitable for a read-only mount. */
  ensure(input: {
    readonly version: Pick<ModuleVersion, "contentId" | "digest" | "moduleId">;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly hostPath: string }>;
}

/**
 * One checkout per Module at a fixed path, holding its Installation's
 * selected Version: selection swaps the new Version's files in before the
 * selection is recorded. `ensure` re-projects whatever no longer matches
 * the selection (an interrupted swap, or files changed on disk).
 */
export interface ModuleSelectedCheckouts extends ModuleCheckouts {
  /**
   * Stages and verifies `version`'s outputs, swaps them in, then runs
   * `record` to select the Version. If `record` fails, the previous files
   * are put back, so the previous selection keeps its files.
   */
  select<T>(
    version: Pick<ModuleVersion, "contentId" | "digest" | "moduleId">,
    record: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T>;
}

/**
 * Whether a Program's private files outlive it: `installation` keeps them
 * with the Installation; `none` gives each run fresh files that go after a
 * confirmed stop and never touch the persistent ones.
 */
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
    /**
     * The starting Program's persistence. An adapter that cannot honor it
     * rejects the prepare rather than substitute the other kind.
     */
    readonly persistence: ModuleFilesPersistence;
    readonly signal?: AbortSignal;
  }): Promise<PreparedInstallationFiles>;
  /** Called once the Program is confirmed stopped; removes `none` files. */
  release(installationId: InstallationId): Promise<void>;
  /** Restores the baseline without consuming it; false if none was recorded. */
  restoreBackup(installationId: InstallationId): Promise<boolean>;
}
