import type {
  Installation,
  InstallationId,
  ModuleVersion,
} from "@foundry/modules/domain";
import type { ModuleCapabilityProvider } from "@foundry/modules/gateway/types";
import {
  carriedGrants,
  type ModuleAccessRequest,
  moduleAccessRequests,
} from "@foundry/modules/grants";
import type { ModuleSystem } from "@foundry/modules/platform/system";
import type { ModuleStore } from "@foundry/modules/store/contract";
import type { WorksExecution } from "~/main/execution/contract";
import { WORKS_TASKS } from "~/shared/execution";
import { OBSERVATION } from "~/shared/observations";
import type {
  SandboxCapacity,
  SandboxReservation,
} from "../sandboxes/capacity";
import type { ModuleSettings } from "../settings";
import { type ModuleRuntime, ModuleRuntimeError } from "./controller";
import {
  ensureModuleInstallation,
  installationPrincipal,
  moduleInstallationId,
} from "./installation";
import { preflightRelease, programResources } from "./preflight";
import { filesPersistence, type ModulePrivateFiles } from "./private-files";
import type { ModuleReleaseFiles } from "./release-files";

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
  readonly releases: Pick<ModuleReleaseFiles, "select">;
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

  /**
   * A persisted `starting`/`active` status is no proof of a live Program:
   * a previous process may have died with it. Interrupted occurrences are
   * moved to a new generation (so their runtime identities are stale) and
   * stopped through the supervisor before anything starts.
   */
  async function reconcile() {
    await recovery.normalizeInterrupted();
    for (const installation of await allInstallations()) {
      if (installation.status === "starting") {
        await programs.stop({
          expectedGeneration: installation.generation,
          installationId: installation.id,
          reason: "Works restarted",
        });
      }
    }
  }
  async function allInstallations() {
    const found: Installation[] = [];
    let cursor: string | undefined;
    do {
      const listed = await store.listInstallations(
        cursor === undefined ? {} : { cursor }
      );
      found.push(...listed.items);
      cursor = listed.nextCursor;
    } while (cursor !== undefined);
    return found;
  }
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
   * selection is recorded; a failed record puts the previous files back.
   */
  function select(
    installation: Installation,
    version: ModuleVersion,
    requests: readonly ModuleAccessRequest[],
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
        const selected = await options.releases.select(
          version,
          () => record(installation, version, requests),
          context.signal
        );
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
  /**
   * Records the selection. Only Grants whose capability, capability version
   * and resolved constraints digest are unchanged carry over; the rest are
   * revoked first, so a failed selection can lose authority but never gain it.
   */
  async function record(
    installation: Installation,
    version: ModuleVersion,
    requests: readonly ModuleAccessRequest[]
  ): Promise<Installation> {
    await store.transaction(async () => {
      const context = await store.loadGatewayContext(installation.id);
      if (!context) {
        throw new ModuleRuntimeError("This Module's Installation is missing");
      }
      const kept = new Set(carriedGrants(context.grants, requests));
      for (const grant of context.grants) {
        if (!kept.has(grant)) {
          await store.revokeInstallationGrant({
            capability: grant.capability,
            expectedGeneration: installation.generation,
            installationId: installation.id,
          });
        }
      }
    });
    return programs.selectVersion({
      contentId: version.contentId,
      expectedGeneration: installation.generation,
      installationId: installation.id,
    });
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
            const current = await store.loadGatewayContext(installationId);
            if (current) {
              await programs.stop({
                expectedGeneration: current.installation.generation,
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
          installation = await select(
            installation,
            version,
            await moduleAccessRequests({
              principal: installationPrincipal(installation, version),
              providers: options.providers,
              version,
            }),
            signal
          );
        }
        const context = await store.loadGatewayContext(installationId);
        await preflightRelease({
          grants: context?.grants ?? [],
          principal: installationPrincipal(installation, version),
          providers: options.providers,
          user,
          version,
        });
        signal.throwIfAborted();
        await programs.start({
          expectedGeneration: installation.generation,
          installationId,
          launch: {
            files: filesPersistence(version.manifest),
            resources: allocated,
          },
          signal,
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
