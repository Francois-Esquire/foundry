import type { ContentId } from "@foundry/artifacts";
import type { ModuleAccess } from "../access";
import type {
  Installation,
  InstallationId,
  ModuleVersion,
  RuntimeInstanceId,
} from "../domain";
import type {
  ModuleCapabilityProvider,
  ModuleRuntimeIdentity,
  ModuleTransport,
} from "../gateway/types";
import type { ActivationPreflight } from "../preflight";
import type { ModuleActivationInput } from "./activation";
import type {
  ModuleFilesPersistence,
  ModuleSelectedCheckouts,
  PreparedInstallationFiles,
} from "./files";

export interface ModuleProgramResources {
  readonly cpus: number;
  readonly memoryBytes: number;
}

/**
 * What the host decided a Program starts with, from its settings and
 * ceilings: it reserves capacity for exactly these resources before it
 * calls start, so start takes them rather than asking again.
 */
export interface ModuleProgramLaunch {
  /** Whether the Program's private files outlive it. */
  readonly files: ModuleFilesPersistence;
  readonly resources: ModuleProgramResources;
}

/**
 * Low-level host lifecycle. Raw start/selectVersion enforce generations and
 * cleanup, not approval/settings policy. Use activate for policy-checked starts,
 * and selection services for Grant carry-over and mutable selected checkouts.
 * All commands share one Installation turn, including activation validation.
 */
export interface ModuleProgramSupervisor {
  /** Policy-checked start, ordered with raw host lifecycle commands. */
  activate(
    input: ModuleActivationInput & {
      readonly providers: readonly ModuleCapabilityProvider[];
      readonly mode?: "user" | "automatic";
      readonly signal?: AbortSignal;
    }
  ): Promise<{
    readonly preflight: ActivationPreflight;
    readonly runtime: ModuleRuntimeIdentity;
  }>;
  active(installationId: InstallationId): Promise<ModuleRuntimeIdentity | null>;
  delete(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
  }): Promise<void>;
  /**
   * Settles a `starting` occurrence `failed` without starting a Program,
   * spending one attempt. What a previous process left of it is stopped
   * first; its files are released only after a confirmed stop, and a failed
   * stop stays pending for the next stop, release or shutdown to retry. An
   * occurrence no longer `starting` at `expectedGeneration` is left alone; one
   * whose Program this process runs is refused as `already-active`.
   */
  failStart(input: {
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
    /** Domain services applied inside the turn, only after confirming a stopped generation. */
    readonly selection?: {
      readonly access: Pick<ModuleAccess, "requests" | "carryOver">;
      readonly checkouts?: Partial<Pick<ModuleSelectedCheckouts, "select">>;
    };
    readonly signal?: AbortSignal;
  }): Promise<Installation>;
  shutdown(reason: string): Promise<void>;
  /** Policy-free host start. The host must resolve/validate its launch before calling. */
  start(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly contentId?: ContentId;
    readonly launch: ModuleProgramLaunch;
    readonly mode?: "user" | "automatic";
    readonly signal?: AbortSignal;
  }): Promise<ModuleRuntimeIdentity>;
  /**
   * User Disable. Without `expectedGeneration`, stops whatever generation is
   * current when the stop's turn runs, after any start already queued.
   */
  stop(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration?: number;
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
    readonly launch: ModuleProgramLaunch;
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
