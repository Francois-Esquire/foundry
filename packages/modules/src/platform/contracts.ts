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

export interface ModuleProgramLaunch {
  readonly files: ModuleFilesPersistence;
  readonly resources: ModuleProgramResources;
}

export interface ModuleProgramSupervisor {
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
  failStart(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
  }): Promise<void>;
  release(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly reason: string;
  }): Promise<void>;
  selectVersion(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly contentId: ContentId;
    readonly selection?: {
      readonly access: Pick<ModuleAccess, "requests" | "carryOver">;
      readonly checkouts?: Partial<Pick<ModuleSelectedCheckouts, "select">>;
    };
    readonly signal?: AbortSignal;
  }): Promise<Installation>;
  shutdown(reason: string): Promise<void>;
  start(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly contentId?: ContentId;
    readonly launch: ModuleProgramLaunch;
    readonly mode?: "user" | "automatic";
    readonly signal?: AbortSignal;
  }): Promise<ModuleRuntimeIdentity>;
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

export class ModuleRuntimeCleanupError extends Error {
  readonly cleanup: () => Promise<void>;

  constructor(cleanup: () => Promise<void>, options: ErrorOptions) {
    super("Module runtime cleanup is incomplete", options);
    this.cleanup = cleanup;
    this.name = "ModuleRuntimeCleanupError";
  }
}

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
