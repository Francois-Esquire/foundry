import type { Installation, InstallationId } from "../domain";
import { MAX_START_ATTEMPTS } from "../domain";
import type { ModuleStore } from "../store/contract";
import {
  ModuleStoreConflictError,
  ModuleStoreNotFoundError,
} from "../store/contract";
import type { ModuleProgramLaunch, ModuleProgramSupervisor } from "./contracts";

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
   * interrupted `stopping` completes to `disabled` through the supervisor,
   * which stops its retained container first. `disabled` and `failed` are
   * the operator's intent and are left untouched.
   */
  normalizeInterrupted(): Promise<void>;
  /**
   * Starts every `starting` Installation once, in stable ID order. A row that
   * has already exhausted its crash-loop budget settles `failed` without a new
   * attempt; a failed attempt settles `failed`, including one whose `launch`
   * throws before the supervisor sees it. Nothing
   * is retried within one boot. The caller decides what each Program
   * starts with, as it does for every start.
   */
  recoverEnabled(input: {
    /**
     * Host policy boundary: resolve and validate the launch before returning.
     * Recovery uses the policy-free supervisor to retain automatic attempt
     * semantics; hosts may call validateModuleActivation here for the same
     * Grant/settings checks as explicit activate.
     */
    readonly launch: (
      installation: Installation
    ) => Promise<ModuleProgramLaunch>;
    readonly signal?: AbortSignal;
  }): Promise<readonly ModuleRecoveryResult[]>;
  /** Host shutdown: release live occurrences without changing status. */
  releaseAll(reason: string): Promise<void>;
  /**
   * For a host that starts Programs only on demand: normalizes interrupted
   * occurrences, which moves them to a new generation so their runtime
   * identities are stale, then stops each one through the supervisor
   * instead of restarting it. Each settles `disabled`.
   */
  stopInterrupted(reason: string): Promise<void>;
}

export interface CreateModuleRuntimeRecoveryOptions {
  /** Campaigns for unrelated Installations running at once. Default 3. */
  readonly concurrency?: number;
  readonly now?: () => Date;
  readonly store: ModuleStore;
  readonly supervisor: Pick<
    ModuleProgramSupervisor,
    "shutdown" | "start" | "stop"
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
    let resolved: ModuleProgramLaunch;
    try {
      resolved = await launch(installation);
    } catch (error) {
      // The supervisor never saw this attempt, so it is settled here, the
      // way the supervisor settles one that fails.
      if (!signal?.aborted) {
        try {
          await settleUnlaunched(installation);
        } catch (settlementError) {
          if (
            !(
              settlementError instanceof ModuleStoreConflictError ||
              settlementError instanceof ModuleStoreNotFoundError
            )
          ) {
            throw settlementError;
          }
        }
      }
      return failed(installation, error);
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

  /**
   * Spends one attempt of an Installation whose launch could not be
   * decided. Only the `starting` row recovery read is settled: one another
   * writer already moved or settled stays as it is.
   */
  function settleUnlaunched(installation: Installation): Promise<void> {
    return options.store.transaction(async () => {
      const current = await options.store.loadGatewayContext(installation.id);
      if (
        current?.installation.generation !== installation.generation ||
        current.installation.status !== "starting"
      ) {
        return;
      }
      await options.store.settleInstallationStatus({
        expectedGeneration: installation.generation,
        installationId: installation.id,
        now: now(),
        status: "failed",
      });
    });
  }

  async function normalizeInterrupted() {
    const stopping: Installation[] = [];
    // Every interrupted occurrence is fenced to a new generation before any
    // cleanup can fail, so no previous process's identity stays current.
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
    // A stop may have died before its container did: each is finished
    // through the supervisor, which settles `disabled` only after a confirmed
    // stop, and `failed` (still reported here) when it cannot stop.
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
