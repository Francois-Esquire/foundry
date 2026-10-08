import type { Installation, InstallationId } from "../domain";
import { MAX_START_ATTEMPTS } from "../domain";
import type { ModuleStore } from "../store/contract";
import type { ModuleProgramSupervisor } from "./contracts";

export type ModuleRecoveryResult =
  | { readonly installationId: InstallationId; readonly kind: "started" }
  | {
      readonly installationId: InstallationId;
      readonly kind: "failed";
      readonly error: Error;
    };

export interface ModuleRuntimeRecovery {
  /**
   * Settles occurrences a prior process interrupted. `starting` / `active`
   * rows are moved back to `starting` so an enabled Module restarts; an
   * interrupted `stopping` completes to `disabled`. `disabled` and `failed`
   * are the operator's intent and are left untouched.
   */
  normalizeInterrupted(): Promise<void>;
  /**
   * Starts every `starting` Installation once, in stable ID order. A row that
   * has already exhausted its crash-loop budget settles `failed` without a new
   * attempt; a failed attempt settles `failed` through the supervisor. Nothing
   * is retried within one boot.
   */
  recoverEnabled(input?: {
    readonly signal?: AbortSignal;
  }): Promise<readonly ModuleRecoveryResult[]>;
  /** Host shutdown: release live occurrences without changing status. */
  releaseAll(reason: string): Promise<void>;
}

export interface CreateModuleRuntimeRecoveryOptions {
  /** Campaigns for unrelated Installations running at once. Default 3. */
  readonly concurrency?: number;
  readonly now?: () => Date;
  readonly store: ModuleStore;
  readonly supervisor: Pick<ModuleProgramSupervisor, "start" | "shutdown">;
}

const DEFAULT_CONCURRENCY = 3;

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
    signal?: AbortSignal
  ): Promise<ModuleRecoveryResult> {
    try {
      await options.supervisor.start({
        expectedGeneration: installation.generation,
        installationId: installation.id,
        mode: "automatic",
        ...(signal === undefined ? {} : { signal }),
      });
      return { installationId: installation.id, kind: "started" };
    } catch (error) {
      return {
        error: error instanceof Error ? error : new Error(String(error)),
        installationId: installation.id,
        kind: "failed",
      };
    }
  }

  return {
    async normalizeInterrupted() {
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
          await options.store.settleInstallationStatus({
            expectedGeneration: installation.generation,
            installationId: installation.id,
            now: now(),
            status: "disabled",
          });
        }
      }
    },

    async recoverEnabled(input = {}) {
      input.signal?.throwIfAborted();
      const candidates = (await listAllInstallations()).filter(
        (installation) => installation.status === "starting"
      );
      const results = new Map<InstallationId, ModuleRecoveryResult>();
      const runnable: Installation[] = [];
      for (const installation of candidates) {
        if (installation.startAttempts >= MAX_START_ATTEMPTS) {
          await options.store.settleInstallationStatus({
            expectedGeneration: installation.generation,
            installationId: installation.id,
            now: now(),
            status: "failed",
          });
          results.set(installation.id, {
            error: new Error(
              `Installation ${installation.id} exhausted its automatic start budget`
            ),
            installationId: installation.id,
            kind: "failed",
          });
          continue;
        }
        runnable.push(installation);
      }

      // Bounded concurrency across unrelated Installations; each start still
      // serializes through the supervisor's per-Installation queue.
      const limit = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(limit, runnable.length) },
          async (): Promise<void> => {
            for (;;) {
              input.signal?.throwIfAborted();
              const installation = runnable[next];
              next += 1;
              if (installation === undefined) {
                return;
              }
              results.set(
                installation.id,
                await attempt(installation, input.signal)
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
  };
}
