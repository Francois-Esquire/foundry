import type {
  Installation,
  InstallationId,
  ModuleVersion,
} from "@foundry/modules/domain";
import type { ModuleCapabilityProvider } from "@foundry/modules/gateway/types";
import type { ModuleSelectedCheckouts } from "@foundry/modules/platform/files";
import {
  createModuleInstallations,
  ModuleActivationRefusedError,
} from "@foundry/modules/platform/installations";
import type { ModuleSystem } from "@foundry/modules/platform/system";
import type { ModuleStore } from "@foundry/modules/store/contract";
import type { WorksExecution } from "~/main/execution/contract";
import { WORKS_TASKS } from "~/shared/execution";
import { OBSERVATION } from "~/shared/observations";
import type {
  SandboxCapacity,
  SandboxReservation,
} from "../sandboxes/capacity";
import { type ModuleSettings, PROGRAM_SETTINGS_POLICY } from "../settings";
import type { ModuleRuntime } from "./controller";
import { ensureModuleInstallation, moduleInstallationId } from "./installation";
import { programResources, releaseRefusal } from "./preflight";
import { filesPersistence, type ModulePrivateFiles } from "./private-files";

export interface InstalledProgramsOptions {
  readonly capacity: Pick<SandboxCapacity, "acquire">;
  /** Version selection is a `system` run. */
  readonly execution: Pick<WorksExecution, "dispatch">;
  /** Told when a Program's stop is confirmed, so disposable files can go. */
  readonly files: Pick<ModulePrivateFiles, "stopped">;
  readonly now?: () => Date;
  /** Checked before the first start, after reconciliation: the native runtime. */
  readonly prepare?: () => Promise<void>;
  readonly providers: readonly ModuleCapabilityProvider[];
  /** Each Module's `artifact/`, replaced when another Version is selected. */
  readonly releases: Pick<ModuleSelectedCheckouts, "select">;
  /** Each Module's user setting values. */
  readonly settings: Pick<ModuleSettings, "user">;
  /** Runs after every Program has stopped. */
  readonly shutdown?: () => Promise<void>;
  /** Told after a Program's confirmed stop: work it started ends with it. */
  readonly stopped?: (installationId: InstallationId) => Promise<void>;
  readonly store: ModuleStore;
  readonly system: Pick<ModuleSystem, "invocations" | "programs" | "recovery">;
}

/**
 * Released Programs on each Module's one durable Installation. Opening an
 * app starts its Program through the framework lifecycle (generation-checked
 * start, stop and Version selection); closing it stops the Program and keeps
 * the Installation, its Grants and its private files. One Program per
 * Module runs at a time.
 */
export function createInstalledPrograms(
  options: InstalledProgramsOptions
): ModuleRuntime {
  const { programs, recovery } = options.system;
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const running = new Map<string, Promise<void>>();

  const installations = createModuleInstallations({
    checkouts: options.releases,
    invocations: options.system.invocations,
    programs,
    providers: options.providers,
    store,
  });

  /**
   * A persisted `starting`/`active` status is no proof of a live Program:
   * a previous process may have died with it. Interrupted occurrences are
   * moved to a new generation (so their runtime identities are stale) and
   * stopped through the supervisor before anything starts.
   */
  const reconcile = () => recovery.stopInterrupted("Works restarted");
  let reconciled: Promise<void> | undefined;
  function reconcileOnce() {
    reconciled ??= reconcile().catch((error: unknown) => {
      reconciled = undefined;
      throw error;
    });
    return reconciled;
  }
  // Settle what a previous process left as soon as Works starts, so Access
  // never shows a dead Program as running; a failure retries at the first
  // start.
  reconcileOnce().catch(() => undefined);
  let prepared: Promise<void> | undefined;
  function prepare() {
    prepared ??= (async () => {
      await reconcileOnce();
      await options.prepare?.();
    })().catch((error: unknown) => {
      prepared = undefined;
      throw error;
    });
    return prepared;
  }

  /**
   * Moves the Installation to `version`, as a `system` run. The Module's
   * previous Program has already stopped (one runs per Module, and a start
   * waits for the previous one's confirmed stop). The frozen release's
   * outputs are staged, checked and swapped in as `artifact/` before the
   * selection is recorded, and only Grants whose request is unchanged carry
   * over; a failed record puts the previous files back.
   */
  function select(
    installation: Installation,
    version: ModuleVersion,
    signal: AbortSignal
  ): Promise<Installation> {
    return options.execution.dispatch(
      WORKS_TASKS.select,
      {
        correlation: {
          contentId: version.contentId,
          moduleId: version.moduleId,
        },
        signal,
      },
      async (context) => {
        const selected = await installations.selectVersion({
          installation,
          signal: context.signal,
          version,
        });
        context.observe({
          data: {
            contentId: version.contentId,
            moduleId: version.moduleId,
            tag: version.tag,
          },
          kind: "result",
          type: OBSERVATION.select,
        });
        return selected;
      }
    );
  }

  return {
    revoked({ installationId, capability }) {
      options.system.invocations.revoke({
        capability,
        installationId,
        reason: "The Grant was revoked",
      });
    },
    async shutdown() {
      await programs.shutdown("Works closed");
      await options.shutdown?.();
    },
    async start(version, signal) {
      signal.throwIfAborted();
      await prepare();
      signal.throwIfAborted();
      while (running.has(version.moduleId)) {
        await waitForClose(running.get(version.moduleId), signal);
      }
      signal.throwIfAborted();
      const slot = Promise.withResolvers<void>();
      running.set(version.moduleId, slot.promise);
      const installationId = moduleInstallationId(version.moduleId);
      let started = false;
      let reservation: SandboxReservation | undefined;
      async function close() {
        try {
          // A started Program stops; so does a start the user abandoned,
          // which the supervisor otherwise leaves `failed`.
          if (started || signal.aborted) {
            started = false;
            if (await store.loadGatewayContext(installationId)) {
              await installations.stop({
                installationId,
                reason: "Module app closed",
              });
              await options.files.stopped(installationId);
              await options.stopped?.(installationId);
            }
          }
        } finally {
          reservation?.release();
          running.delete(version.moduleId);
          slot.resolve();
        }
      }
      try {
        // Requirements this host cannot meet refuse the start before
        // anything is acquired. Released Programs count against the same
        // machine ceilings as Module sandboxes, and wait the same way.
        const user = await options.settings.user(version.moduleId);
        const allocated = programResources(version, user);
        reservation = await options.capacity.acquire(allocated.memoryBytes, {
          signal,
        });
        let installation = await ensureModuleInstallation(
          store,
          version,
          now()
        );
        if (installation.contentId !== version.contentId) {
          installation = await select(installation, version, signal);
        }
        signal.throwIfAborted();
        await installations
          .start({
            installation,
            launch: {
              files: filesPersistence(version.manifest),
              resources: allocated,
            },
            settings: { policy: PROGRAM_SETTINGS_POLICY, user },
            signal,
            version,
          })
          .catch((error: unknown) => {
            throw error instanceof ModuleActivationRefusedError
              ? releaseRefusal(error.facts)
              : error;
          });
        started = true;
        const endpoint = await programs.viewEndpoint({ installationId });
        if (!endpoint) {
          throw new Error("Module did not publish a view endpoint");
        }
        return { close, origin: endpoint.origin };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}

async function waitForClose(
  previous: Promise<void> | undefined,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([previous, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
