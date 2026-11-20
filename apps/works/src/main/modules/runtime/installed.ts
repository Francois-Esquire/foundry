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
import { ModuleProgramSupervisorError } from "@foundry/modules/platform/program-supervisor";
import type { ModuleSystem } from "@foundry/modules/platform/system";
import type { ModuleCommands } from "@foundry/modules/registry";
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
  readonly execution: Pick<WorksExecution, "dispatch">;
  readonly files: Pick<ModulePrivateFiles, "stopped">;
  readonly now?: () => Date;
  readonly prepare?: () => Promise<void>;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly releases: Pick<ModuleSelectedCheckouts, "select">;
  readonly settings: Pick<ModuleSettings, "user">;
  readonly shutdown?: () => Promise<void>;
  readonly stopped?: (installationId: InstallationId) => Promise<void>;
  readonly stopRetryMs?: number;
  readonly store: ModuleCommands;
  readonly system: Pick<ModuleSystem, "invocations" | "programs" | "recovery">;
}

export function createInstalledPrograms(
  options: InstalledProgramsOptions
): ModuleRuntime {
  const { programs, recovery } = options.system;
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const running = new Map<string, RunningProgram>();
  const firstRetryMs = options.stopRetryMs ?? DEFAULT_STOP_RETRY_MS;
  const retries = new Set<ReturnType<typeof setTimeout>>();
  let shuttingDown = false;
  function retryLater(entry: RunningProgram, waitMs: number) {
    const close = entry.retry;
    if (shuttingDown || !close) {
      entry.retrying = false;
      return;
    }
    entry.retrying = true;
    const timer = setTimeout(() => {
      retries.delete(timer);
      close().catch((error: unknown) => {
        if (stillCleaning(error)) {
          retryLater(entry, Math.min(waitMs * 2, MAX_STOP_RETRY_MS));
        } else {
          entry.retrying = false;
        }
      });
    }, waitMs);
    timer.unref?.();
    retries.add(timer);
  }

  const installations = createModuleInstallations({
    checkouts: options.releases,
    invocations: options.system.invocations,
    programs,
    providers: options.providers,
    store,
  });

  const reconcile = () => recovery.stopInterrupted("Works restarted");
  let reconciled: Promise<void> | undefined;
  function reconcileOnce() {
    reconciled ??= reconcile().catch((error: unknown) => {
      reconciled = undefined;
      throw error;
    });
    return reconciled;
  }
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
      shuttingDown = true;
      for (const timer of retries) {
        clearTimeout(timer);
      }
      retries.clear();
      await programs.shutdown("Works closed");
      await options.shutdown?.();
    },
    async start(version, signal) {
      signal.throwIfAborted();
      await prepare();
      signal.throwIfAborted();
      for (
        let previous = running.get(version.moduleId);
        previous;
        previous = running.get(version.moduleId)
      ) {
        if (previous.retry) {
          await previous.retry();
        } else {
          await waitForClose(previous.closing, signal);
        }
        signal.throwIfAborted();
      }
      const slot = Promise.withResolvers<void>();
      const entry: RunningProgram = { closing: slot.promise };
      running.set(version.moduleId, entry);
      const installationId = moduleInstallationId(version.moduleId);
      let started = false;
      let mustStop = false;
      let reservation: SandboxReservation | undefined;
      let finished = false;
      function finish() {
        if (finished) {
          return;
        }
        finished = true;
        reservation?.release();
        running.delete(version.moduleId);
        slot.resolve();
      }
      async function stop() {
        mustStop ||= started || signal.aborted;
        started = false;
        if (!mustStop) {
          finish();
          return;
        }
        try {
          if (await store.loadGatewayContext(installationId)) {
            await installations.stop({
              installationId,
              reason: "Module app closed",
            });
          }
        } catch (error) {
          entry.retry = close;
          slot.resolve();
          if (stillCleaning(error) && !entry.retrying) {
            retryLater(entry, firstRetryMs);
          }
          throw error;
        }
        mustStop = false;
        entry.retry = undefined;
        try {
          await options.files.stopped(installationId);
          await options.stopped?.(installationId);
        } finally {
          finish();
        }
      }
      let closing: Promise<void> | undefined;
      function close(): Promise<void> {
        closing ??= stop().finally(() => {
          closing = undefined;
        });
        return closing;
      }
      try {
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
        await close().catch(() => undefined);
        throw error;
      }
    },
  };
}

interface RunningProgram {
  readonly closing: Promise<void>;
  retry?: (() => Promise<void>) | undefined;
  retrying?: boolean;
}

const DEFAULT_STOP_RETRY_MS = 1000;
const MAX_STOP_RETRY_MS = 30_000;

function stillCleaning(error: unknown): boolean {
  return (
    error instanceof ModuleProgramSupervisorError &&
    error.code === "cleanup-pending"
  );
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
