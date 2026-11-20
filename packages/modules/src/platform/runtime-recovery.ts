import type { Installation, InstallationId } from "../domain";
import { MAX_START_ATTEMPTS } from "../domain";
import { ModuleStoreConflictError, ModuleStoreNotFoundError } from "../errors";
import type { ModuleCommands } from "../registry";
import type { ModuleProgramLaunch, ModuleProgramSupervisor } from "./contracts";
import { ModuleProgramSupervisorError } from "./program-supervisor-errors";

export type ModuleRecoveryResult =
  | { readonly installationId: InstallationId; readonly kind: "started" }
  | {
      readonly installationId: InstallationId;
      readonly kind: "failed";
      readonly error: Error;
    };

export interface ModuleRuntimeRecovery {
  normalizeInterrupted(): Promise<void>;
  recoverEnabled(input: {
    readonly launch: (
      installation: Installation
    ) => Promise<ModuleProgramLaunch>;
    readonly signal?: AbortSignal;
  }): Promise<readonly ModuleRecoveryResult[]>;
  releaseAll(reason: string): Promise<void>;
  stopInterrupted(reason: string): Promise<void>;
}

export interface CreateModuleRuntimeRecoveryOptions {
  readonly concurrency?: number;
  readonly now?: () => Date;
  readonly store: ModuleCommands;
  readonly supervisor: Pick<
    ModuleProgramSupervisor,
    "failStart" | "shutdown" | "start" | "stop"
  >;
}

const DEFAULT_CONCURRENCY = 3;

function failed(
  installation: Installation,
  error: unknown
): ModuleRecoveryResult {
  return {
    error: error instanceof Error ? error : new Error(String(error)),
    installationId: installation.id,
    kind: "failed",
  };
}

export function createModuleRuntimeRecovery(
  options: CreateModuleRuntimeRecoveryOptions
): ModuleRuntimeRecovery {
  const now = options.now ?? (() => new Date());

  async function listAllInstallations(): Promise<readonly Installation[]> {
    const installations: Installation[] = [];
    let cursor: string | undefined;
    do {
      const page = await options.store.listInstallations(
        cursor === undefined ? {} : { cursor }
      );
      installations.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return installations;
  }

  async function attempt(
    installation: Installation,
    launch: (installation: Installation) => Promise<ModuleProgramLaunch>,
    signal?: AbortSignal
  ): Promise<ModuleRecoveryResult> {
    if (installation.startAttempts >= MAX_START_ATTEMPTS) {
      return failStart(
        installation,
        new Error(
          `Installation ${installation.id} exhausted its automatic start budget`
        )
      );
    }
    let resolved: ModuleProgramLaunch;
    try {
      resolved = await launch(installation);
    } catch (error) {
      return signal?.aborted
        ? failed(installation, error)
        : failStart(installation, error);
    }
    try {
      await options.supervisor.start({
        expectedGeneration: installation.generation,
        installationId: installation.id,
        launch: resolved,
        mode: "automatic",
        ...(signal === undefined ? {} : { signal }),
      });
      return { installationId: installation.id, kind: "started" };
    } catch (error) {
      return failed(installation, error);
    }
  }

  async function failStart(
    installation: Installation,
    error: unknown
  ): Promise<ModuleRecoveryResult> {
    try {
      await options.supervisor.failStart({
        expectedGeneration: installation.generation,
        installationId: installation.id,
      });
    } catch (cleanupError) {
      if (cleanupError instanceof ModuleProgramSupervisorError) {
        const reason = error instanceof Error ? error.message : String(error);
        return failed(
          installation,
          new AggregateError(
            [error, cleanupError],
            `${reason}; ${cleanupError.message}`,
            { cause: error }
          )
        );
      }
      if (
        !(
          cleanupError instanceof ModuleStoreConflictError ||
          cleanupError instanceof ModuleStoreNotFoundError
        )
      ) {
        throw cleanupError;
      }
    }
    return failed(installation, error);
  }

  async function normalizeInterrupted() {
    const stopping: Installation[] = [];
    for (const installation of await listAllInstallations()) {
      if (
        installation.status === "starting" ||
        installation.status === "active"
      ) {
        await options.store.beginInstallationTransition({
          expectedGeneration: installation.generation,
          installationId: installation.id,
          now: now(),
          status: "starting",
        });
      } else if (installation.status === "stopping") {
        stopping.push(installation);
      }
    }
    const failures: unknown[] = [];
    for (const installation of stopping) {
      await options.supervisor
        .stop({
          expectedGeneration: installation.generation,
          installationId: installation.id,
          reason: "Completing an interrupted stop",
        })
        .catch((error: unknown) => failures.push(error));
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Interrupted Module stops failed");
    }
  }

  return {
    normalizeInterrupted,

    async recoverEnabled(input) {
      input.signal?.throwIfAborted();
      const candidates = (await listAllInstallations()).filter(
        (installation) => installation.status === "starting"
      );
      const results = new Map<InstallationId, ModuleRecoveryResult>();
      const limit = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(limit, candidates.length) },
          async (): Promise<void> => {
            for (;;) {
              input.signal?.throwIfAborted();
              const installation = candidates[next];
              next += 1;
              if (installation === undefined) {
                return;
              }
              results.set(
                installation.id,
                await attempt(installation, input.launch, input.signal)
              );
            }
          }
        )
      );

      return Object.freeze(
        candidates.flatMap((installation) => {
          const result = results.get(installation.id);
          return result === undefined ? [] : [result];
        })
      );
    },

    async releaseAll(reason) {
      await options.supervisor.shutdown(reason);
    },

    async stopInterrupted(reason) {
      await normalizeInterrupted();
      for (const installation of await listAllInstallations()) {
        if (installation.status === "starting") {
          await options.supervisor.stop({
            expectedGeneration: installation.generation,
            installationId: installation.id,
            reason,
          });
        }
      }
    },
  };
}
