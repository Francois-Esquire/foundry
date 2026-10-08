import type { ContentId } from "@foundry/artifacts";

import type {
  Installation,
  InstallationId,
  ModuleVersion,
  RuntimeInstanceId,
} from "../domain";
import type { ModuleRuntimeIdentity, ModuleTransport } from "../gateway/types";
import type { PreparedInstallationFiles } from "./files";

export interface ModuleProgramSupervisor {
  active(installationId: InstallationId): Promise<ModuleRuntimeIdentity | null>;
  delete(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
  }): Promise<void>;
  /** Releases resources without recording a user Disable. */
  release(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly reason: string;
  }): Promise<void>;
  selectVersion(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly contentId: ContentId;
  }): Promise<Installation>;
  shutdown(reason: string): Promise<void>;
  start(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly contentId?: ContentId;
    readonly mode?: "user" | "automatic";
    readonly signal?: AbortSignal;
  }): Promise<ModuleRuntimeIdentity>;
  stop(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly reason: string;
  }): Promise<void>;
  viewEndpoint(input: { readonly installationId: InstallationId }): Promise<{
    readonly origin: string;
    readonly generation: number;
  } | null>;
}

export interface ModuleProgramRuntimeHandle {
  readonly programOrigin?: string;
  readonly runtimeInstanceId: RuntimeInstanceId;
  /** Resolves only after all writers stop; rejection must remain retryable. */
  stop(reason: string): Promise<void>;
  readonly transport: ModuleTransport;
}

export interface ModuleProgramRuntimeAdapter {
  start(input: {
    readonly installationId: InstallationId;
    readonly generation: number;
    readonly version: ModuleVersion;
    readonly files: PreparedInstallationFiles;
    readonly signal?: AbortSignal;
  }): Promise<ModuleProgramRuntimeHandle>;
}

/** Startup failed while resources remained live. The owner must retry cleanup. */
export class ModuleRuntimeCleanupError extends Error {
  readonly cleanup: () => Promise<void>;

  constructor(cleanup: () => Promise<void>, options: ErrorOptions) {
    super("Module runtime cleanup is incomplete", options);
    this.cleanup = cleanup;
    this.name = "ModuleRuntimeCleanupError";
  }
}

/**
 * Cleans up after `error`, then rethrows it. A failed cleanup is handed to the
 * owner as a retryable `ModuleRuntimeCleanupError` instead.
 */
export async function rethrowAfterCleanup(
  error: unknown,
  cleanup: () => Promise<void>,
  message: string
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    // biome-ignore lint/style/useErrorCause: The cause is an AggregateError holding both the original failure and `cleanupError`, so the owner sees each.
    throw new ModuleRuntimeCleanupError(cleanup, {
      cause: new AggregateError([error, cleanupError], message, {
        cause: error,
      }),
    });
  }
  throw error;
}
