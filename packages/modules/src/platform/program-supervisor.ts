import type { ContentId } from "@foundry/artifacts";

import type { Installation, InstallationId, ModuleVersion } from "../domain";
import type {
  ModuleGateway,
  ModuleGatewaySession,
  ModuleRuntimeIdentity,
} from "../gateway/types";
import type { ModuleStore } from "../store/contract";
import type { ModuleVersions } from "../version";
import type {
  ModuleProgramRuntimeAdapter,
  ModuleProgramRuntimeHandle,
  ModuleProgramSupervisor,
} from "./contracts";
import { ModuleRuntimeCleanupError } from "./contracts";
import type { ModuleInstallationFiles } from "./files";
import { settledTransitionNotifier } from "./observation";
import { KeyedTurns } from "./turns";

export type ModuleProgramSupervisorErrorCode =
  | "installation-not-found"
  | "stale-generation"
  | "version-not-found"
  | "already-active"
  | "startup-failed"
  | "cleanup-pending"
  | "teardown-failed"
  | "shutting-down";

export class ModuleProgramSupervisorError extends Error {
  readonly code: ModuleProgramSupervisorErrorCode;

  constructor(
    code: ModuleProgramSupervisorErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
    this.name = "ModuleProgramSupervisorError";
  }
}

export interface CreateModuleProgramSupervisorOptions {
  readonly files: ModuleInstallationFiles;
  readonly gateway: ModuleGateway;
  readonly now?: () => Date;
  /**
   * Composition-boundary observation of settled Installation transitions.
   * Invoked only after a status settles — never on begin, and never awaited:
   * the observer can neither delay nor roll back the committed transition.
   * Host-shutdown teardown is deliberately silent.
   */
  readonly onSettledTransition?: (installationId: InstallationId) => void;
  readonly removeContainer: (containerId: string) => Promise<void>;
  readonly runtime: ModuleProgramRuntimeAdapter;
  readonly stopRetainedContainer: (containerId: string) => Promise<void>;
  readonly store: ModuleStore;
  /** Bounds caller/shutdown observation, never the underlying cleanup task. */
  readonly teardownObservationMs?: number;
  readonly versions: Pick<ModuleVersions, "load">;
}

/** Coordinates the complete Program lifetime as one Installation-scoped turn. */
export function createModuleProgramSupervisor(
  options: CreateModuleProgramSupervisorOptions
): ModuleProgramSupervisor {
  return new DefaultModuleProgramSupervisor(options);
}

/** A published Program: present here only once its Installation is `active`. */
interface ActiveRecord {
  readonly handle: ModuleProgramRuntimeHandle;
  readonly runtime: ModuleRuntimeIdentity;
  readonly session: ModuleGatewaySession;
}

interface TeardownRecord {
  failed: boolean;
  generation: number;
  readonly retry: () => Promise<void>;
  readonly task: Promise<void>;
}

const DEFAULT_TEARDOWN_OBSERVATION_MS = 10_000;

class DefaultModuleProgramSupervisor implements ModuleProgramSupervisor {
  readonly #active = new Map<InstallationId, ActiveRecord>();
  readonly #teardowns = new Map<InstallationId, TeardownRecord>();
  readonly #turns = new KeyedTurns<InstallationId>();
  /** Aborted at host shutdown: refuses new starts and cancels running ones. */
  readonly #closing = new AbortController();
  readonly #now: () => Date;
  readonly #notifySettled: (installationId: InstallationId) => void;
  readonly #teardownObservationMs: number;
  private readonly options: CreateModuleProgramSupervisorOptions;

  constructor(options: CreateModuleProgramSupervisorOptions) {
    this.options = options;
    this.#now = options.now ?? (() => new Date());
    this.#notifySettled = settledTransitionNotifier(
      options.onSettledTransition
    );
    this.#teardownObservationMs =
      options.teardownObservationMs ?? DEFAULT_TEARDOWN_OBSERVATION_MS;
  }

  start(input: StartInput): Promise<ModuleRuntimeIdentity> {
    return this.#turns.run(input.installationId, () => {
      this.#assertOpen();
      return this.#start({
        ...input,
        signal:
          input.signal === undefined
            ? this.#closing.signal
            : AbortSignal.any([input.signal, this.#closing.signal]),
      });
    });
  }

  /** User Disable: `stopping` → teardown → `disabled`. */
  stop(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly reason: string;
  }): Promise<void> {
    return this.#turns.run(input.installationId, async () => {
      const installation = await this.#installationAt(
        input.installationId,
        input.expectedGeneration
      );
      if (
        installation.status === "disabled" &&
        !this.#teardowns.has(input.installationId)
      ) {
        return;
      }
      const active = this.#active.get(input.installationId);
      if (
        active !== undefined &&
        active.runtime.generation !== input.expectedGeneration
      ) {
        throw supervisorError(
          "stale-generation",
          `Runtime Instance generation is ${active.runtime.generation}, not ${input.expectedGeneration}`
        );
      }
      const stopping = await this.options.store.beginInstallationTransition({
        expectedGeneration: input.expectedGeneration,
        installationId: input.installationId,
        now: this.#now(),
        status: "stopping",
      });
      // The row stays `stopping` while cleanup is pending; late cleanup
      // settles it `disabled`.
      const observed = await this.#observeCleanup(
        input.installationId,
        this.#beginTeardown(
          input.installationId,
          stopping.generation,
          active,
          input.reason
        ),
        "disabled"
      );
      if (observed.kind === "settled") {
        await this.#settle(
          input.installationId,
          stopping.generation,
          "disabled"
        );
        return;
      }
      if (observed.kind === "pending") {
        throw supervisorError(
          "cleanup-pending",
          `Installation ${input.installationId} cleanup is still pending`
        );
      }
      // Teardown failed outright: the occurrence is not cleanly gone.
      await this.#settle(input.installationId, stopping.generation, "failed");
      throw observed.error;
    });
  }

  /**
   * Host shutdown and Release change: release the live occurrence without any
   * Store write, so an Installation left `starting` / `active` is restarted by
   * the next activation, or by boot recovery if the host exits first.
   */
  release(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly reason: string;
  }): Promise<void> {
    return this.#turns.run(input.installationId, () => this.#release(input));
  }

  async #release(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly reason: string;
  }): Promise<void> {
    await this.#installationAt(input.installationId, input.expectedGeneration);
    const active = this.#active.get(input.installationId);
    if (active === undefined && !this.#teardowns.has(input.installationId)) {
      return;
    }
    if (
      active !== undefined &&
      active.runtime.generation !== input.expectedGeneration
    ) {
      throw supervisorError(
        "stale-generation",
        `Runtime Instance generation is ${active.runtime.generation}, not ${input.expectedGeneration}`
      );
    }
    const observed = await this.#observeCleanup(
      input.installationId,
      this.#beginTeardown(
        input.installationId,
        input.expectedGeneration,
        active,
        input.reason
      )
    );
    if (observed.kind === "settled") {
      return;
    }
    if (observed.kind === "pending") {
      throw supervisorError(
        "cleanup-pending",
        `Installation ${input.installationId} cleanup is still pending`
      );
    }
    throw observed.error;
  }

  selectVersion(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly contentId: ContentId;
  }): Promise<Installation> {
    return this.#turns.run(input.installationId, async () => {
      this.#assertOpen();
      const installation = await this.#installationAt(
        input.installationId,
        input.expectedGeneration
      );
      if (
        installation.status !== "disabled" &&
        installation.status !== "failed"
      ) {
        throw supervisorError(
          "already-active",
          "Stop the Installation before selecting a version"
        );
      }
      await this.#release({ ...input, reason: "Selecting Module version" });
      if (installation.containerId !== null) {
        await this.options.stopRetainedContainer(installation.containerId);
      }
      const generation = await this.#selectProposedVersion(input);
      const selected = await this.#installationAt(
        input.installationId,
        generation
      );
      this.#notifySettled(input.installationId);
      return selected;
    });
  }

  delete(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
  }): Promise<void> {
    return this.#turns.run(input.installationId, async () => {
      this.#assertOpen();
      await this.#installationAt(
        input.installationId,
        input.expectedGeneration
      );
      await this.#release({ ...input, reason: "Deleting Module Installation" });
      let installation = await this.#installationAt(
        input.installationId,
        input.expectedGeneration
      );
      if (
        installation.status !== "disabled" &&
        installation.status !== "failed"
      ) {
        installation = await this.options.store.beginInstallationTransition({
          ...input,
          now: this.#now(),
          status: "stopping",
        });
        await this.#settle(
          input.installationId,
          installation.generation,
          "disabled"
        );
      }
      if (installation.containerId !== null) {
        await this.options.removeContainer(installation.containerId);
      }
      await this.options.files.delete(input.installationId);
      await this.options.store.deleteInstallation({
        expectedGeneration: installation.generation,
        installationId: input.installationId,
      });
      this.#notifySettled(input.installationId);
    });
  }

  active(
    installationId: InstallationId
  ): Promise<ModuleRuntimeIdentity | null> {
    const active = this.#active.get(installationId);
    return Promise.resolve(active?.runtime ?? null);
  }

  viewEndpoint(input: {
    readonly installationId: InstallationId;
  }): Promise<{ readonly origin: string; readonly generation: number } | null> {
    const active = this.#active.get(input.installationId);
    if (active?.handle.programOrigin === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      generation: active.runtime.generation,
      origin: active.handle.programOrigin,
    });
  }

  async shutdown(reason: string): Promise<void> {
    this.#closing.abort(new Error(reason));
    // The registry's own shutdown does not wait for starts, so every turn
    // already running must finish acquiring or cleaning up before it begins.
    await this.#turns.idle();
    const failures: unknown[] = [];
    for (const [installationId, teardown] of [...this.#teardowns]) {
      await this.release({
        expectedGeneration: teardown.generation,
        installationId,
        reason,
      }).catch((error: unknown) => failures.push(error));
    }
    for (const [installationId, active] of [...this.#active]) {
      await this.release({
        expectedGeneration: active.runtime.generation,
        installationId,
        reason,
      }).catch((error: unknown) => {
        failures.push(error);
      });
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Module Program shutdown failed");
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Start is one ordered transaction across Store, files, runtime, and Gateway; its failure path must see exactly which resources came up.
  async #start(input: StartInput): Promise<ModuleRuntimeIdentity> {
    input.signal?.throwIfAborted();
    const current = this.#active.get(input.installationId);
    if (current !== undefined) {
      if (
        current.runtime.generation === input.expectedGeneration + 1 &&
        (input.contentId === undefined ||
          input.contentId === current.runtime.contentId)
      ) {
        return current.runtime;
      }
      throw supervisorError(
        "already-active",
        `Installation ${input.installationId} already has another Runtime Instance`
      );
    }
    if (this.#teardowns.has(input.installationId)) {
      throw supervisorError(
        "cleanup-pending",
        `Installation ${input.installationId} cleanup is still pending`
      );
    }

    // Validate the generation before any durable data work, so a stale start
    // fails cleanly with `stale-generation` rather than a Store conflict.
    const installation = await this.#installationAt(
      input.installationId,
      input.expectedGeneration
    );
    if (installation.containerId !== null) {
      await this.options.stopRetainedContainer(installation.containerId);
    }
    // A proposed version is selected atomically just before the occurrence
    // begins, so the generation the Program runs under already names it.
    const baseGeneration = await this.#selectProposedVersion(input);
    const activating = await this.options.store.beginInstallationTransition({
      expectedGeneration: baseGeneration,
      installationId: input.installationId,
      now: this.#now(),
      resetStartAttempts: input.mode !== "automatic",
      status: "starting",
    });

    let handle: ModuleProgramRuntimeHandle | undefined;
    let session: ModuleGatewaySession | undefined;
    try {
      const version = await this.#loadSelection(
        input.installationId,
        activating.generation
      );
      input.signal?.throwIfAborted();
      const files = await this.options.files.prepare({
        installationId: input.installationId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      // A failed or interrupted version change must retry from its original database.
      await this.options.files.restoreBackup(input.installationId);
      handle = await this.options.runtime.start({
        files,
        generation: activating.generation,
        installationId: input.installationId,
        version,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      input.signal?.throwIfAborted();
      // Host-bound: every field comes from the Store row and the container
      // the host opened, never from anything the guest reports.
      const runtime: ModuleRuntimeIdentity = Object.freeze({
        contentId: version.contentId,
        generation: activating.generation,
        installationId: input.installationId,
        runtimeInstanceId: handle.runtimeInstanceId,
      });
      session = await this.options.gateway.connect({
        capabilities: version.manifest.capabilities,
        runtime,
        transport: handle.transport,
      });
      await this.#loadSelection(input.installationId, activating.generation);
      input.signal?.throwIfAborted();
      await this.options.files.discardBackup(input.installationId);
      await this.options.store.settleInstallationStatus({
        expectedGeneration: activating.generation,
        installationId: input.installationId,
        now: this.#now(),
        status: "active",
      });
      const active = Object.freeze({ handle, runtime, session });
      this.#active.set(input.installationId, active);
      this.#observeUnexpectedClose(input.installationId, active);
      this.#notifySettled(input.installationId);
      return runtime;
    } catch (error) {
      let runtimeCleanup =
        error instanceof ModuleRuntimeCleanupError ? error.cleanup : undefined;
      const cleanup = this.#recordCleanup(
        input.installationId,
        activating.generation,
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: A retryable cleanup clears each released resource from the enclosing start's state, so a retry repeats only what is still live.
        async () => {
          const failures: unknown[] = [];
          if (session !== undefined) {
            try {
              await session.close("Program startup failed");
              session = undefined;
            } catch (cleanupError) {
              failures.push(cleanupError);
            }
          }
          if (handle !== undefined) {
            try {
              await handle.stop("Program startup failed");
              handle = undefined;
            } catch (cleanupError) {
              failures.push(cleanupError);
            }
          }
          if (runtimeCleanup !== undefined) {
            try {
              await runtimeCleanup();
              runtimeCleanup = undefined;
            } catch (cleanupError) {
              failures.push(cleanupError);
            }
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              "Module startup resources remain live"
            );
          }
          await this.options.files.restoreBackup(input.installationId);
          await this.options.files.release(input.installationId);
        }
      );
      const observed = await this.#observeCleanup(
        input.installationId,
        cleanup
      );
      // A start cancelled by host shutdown stays `starting`, so the next boot
      // recovers it without spending one of its attempts.
      if (!this.#closing.signal.aborted) {
        await this.#settle(
          input.installationId,
          activating.generation,
          "failed"
        ).catch(() => undefined);
      }
      if (observed.kind !== "settled") {
        throw supervisorError(
          observed.kind === "pending" ? "cleanup-pending" : "teardown-failed",
          `Installation ${input.installationId} startup cleanup is incomplete`,
          new AggregateError(
            [error, ...(observed.kind === "failed" ? [observed.error] : [])],
            "Module startup and cleanup failed",
            { cause: error }
          )
        );
      }
      if (error instanceof ModuleProgramSupervisorError) {
        throw error;
      }
      throw supervisorError(
        "startup-failed",
        startupFailureMessage(input.installationId, error),
        error
      );
    }
  }

  /** Selects a proposed version before start; returns the generation to begin at. */
  async #selectProposedVersion(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
    readonly contentId?: ContentId;
  }): Promise<number> {
    if (input.contentId === undefined) {
      return input.expectedGeneration;
    }
    const installation = await this.#installationAt(
      input.installationId,
      input.expectedGeneration
    );
    if (installation.contentId === input.contentId) {
      return input.expectedGeneration;
    }
    const version = await this.#version(installation, input.contentId);
    // Nothing of this Installation runs inside its own turn, so the copy is
    // taken with every writer stopped.
    await this.options.files.backup(input.installationId);
    const selected = await this.options.store.selectInstallationVersion({
      expectedGeneration: input.expectedGeneration,
      installationId: input.installationId,
      now: this.#now(),
      version,
    });
    return selected.generation;
  }

  /** The pinned Content, re-validated as a version of the Installation's Module. */
  async #version(
    installation: Installation,
    contentId: ContentId
  ): Promise<ModuleVersion> {
    let version: ModuleVersion | null;
    try {
      version = await this.options.versions.load({
        contentId,
        moduleId: installation.moduleId,
      });
    } catch (error) {
      throw supervisorError(
        "version-not-found",
        `Content ${contentId} is not a version of Module ${installation.moduleId}`,
        error
      );
    }
    if (version === null) {
      throw supervisorError(
        "version-not-found",
        `Selected Content ${contentId} was not found`
      );
    }
    return version;
  }

  async #loadSelection(
    installationId: InstallationId,
    expectedGeneration: number
  ): Promise<ModuleVersion> {
    const installation = await this.#installationAt(
      installationId,
      expectedGeneration
    );
    return this.#version(installation, installation.contentId);
  }

  #assertOpen(): void {
    if (this.#closing.signal.aborted) {
      throw supervisorError(
        "shutting-down",
        "Module Programs are shutting down"
      );
    }
  }

  async #installationAt(
    installationId: InstallationId,
    expectedGeneration: number
  ): Promise<Installation> {
    const context = await this.options.store.loadGatewayContext(installationId);
    if (context === null) {
      throw supervisorError(
        "installation-not-found",
        `Installation ${installationId} was not found`
      );
    }
    if (context.installation.generation !== expectedGeneration) {
      throw supervisorError(
        "stale-generation",
        `Installation generation is ${context.installation.generation}, not ${expectedGeneration}`
      );
    }
    return context.installation;
  }

  async #settle(
    installationId: InstallationId,
    expectedGeneration: number,
    status: "active" | "disabled" | "failed"
  ): Promise<Installation> {
    const settled = await this.options.store.settleInstallationStatus({
      expectedGeneration,
      installationId,
      now: this.#now(),
      status,
    });
    this.#notifySettled(installationId);
    return settled;
  }

  #observeUnexpectedClose(
    installationId: InstallationId,
    active: ActiveRecord
  ): void {
    active.session.closed
      .then((close) =>
        this.#turns.run(installationId, async () => {
          if (this.#active.get(installationId) !== active) {
            return;
          }
          const { generation } = active.runtime;
          console.warn(
            `[module-program] ${installationId} Gateway session closed unexpectedly (${close.code}): ${close.reason}; settling failed`
          );
          await this.#observeCleanup(
            installationId,
            this.#beginTeardown(
              installationId,
              generation,
              active,
              close.reason
            )
          );
          // A crashed Program records a failed occurrence without touching the
          // user's intent; v1 never restarts it in-process.
          // biome-ignore lint/suspicious/noNestedPromises: Settling is best-effort inside the queued turn; this catch swallows only #settle's rejection so the turn still completes.
          await this.#settle(installationId, generation, "failed").catch(
            () => undefined
          );
        })
      )
      .catch(() => undefined);
  }

  async #teardown(
    installationId: InstallationId,
    active: ActiveRecord,
    reason: string
  ): Promise<void> {
    const failures: unknown[] = [];
    await attempt(() => active.session.close(reason), failures);
    await attempt(() => active.handle.stop(reason), failures);
    await attempt(() => this.options.files.release(installationId), failures);
    if (this.#active.get(installationId) === active) {
      this.#active.delete(installationId);
    }
    if (failures.length > 0) {
      throw supervisorError(
        "teardown-failed",
        `Could not completely stop Installation ${installationId}`,
        failures[0]
      );
    }
  }

  #beginTeardown(
    installationId: InstallationId,
    generation: number,
    active: ActiveRecord | undefined,
    reason: string
  ): TeardownRecord {
    const existing = this.#teardowns.get(installationId);
    if (existing !== undefined) {
      existing.generation = generation;
      return existing.failed
        ? this.#recordCleanup(installationId, generation, existing.retry)
        : existing;
    }
    if (active !== undefined && this.#active.get(installationId) === active) {
      this.#active.delete(installationId);
    }
    return this.#recordCleanup(installationId, generation, () =>
      active === undefined
        ? this.options.files.release(installationId)
        : this.#teardown(installationId, active, reason)
    );
  }

  #recordCleanup(
    installationId: InstallationId,
    generation: number,
    retry: () => Promise<void>
  ): TeardownRecord {
    const record: TeardownRecord = {
      failed: false,
      generation,
      retry,
      task: Promise.resolve()
        .then(retry)
        .catch((error: unknown) => {
          record.failed = true;
          throw error;
        }),
    };
    this.#teardowns.set(installationId, record);
    record.task.catch(() => undefined);
    return record;
  }

  /**
   * Waits a bounded time for cleanup. Settled cleanup is forgotten; pending
   * cleanup is resolved late, settling `lateStatus` when given.
   */
  async #observeCleanup(
    installationId: InstallationId,
    record: TeardownRecord,
    lateStatus?: "disabled"
  ): Promise<TeardownObservation> {
    const observed = await observeTeardown(
      record.task,
      this.#teardownObservationMs
    );
    if (observed.kind === "settled") {
      this.#teardowns.delete(installationId);
    } else if (observed.kind === "pending") {
      this.#resolveLateCleanup(installationId, record, lateStatus);
    }
    return observed;
  }

  #resolveLateCleanup(
    installationId: InstallationId,
    record: TeardownRecord,
    settleStatus?: "disabled"
  ): void {
    record.task
      .then(async () => {
        if (this.#teardowns.get(installationId) !== record) {
          return;
        }
        this.#teardowns.delete(installationId);
        if (settleStatus !== undefined) {
          await this.#settle(installationId, record.generation, settleStatus);
        }
      })
      .catch(() => undefined);
  }
}

type TeardownObservation =
  | { readonly kind: "settled" }
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly error: unknown };

function observeTeardown(
  task: Promise<void>,
  timeoutMs: number
): Promise<TeardownObservation> {
  return new Promise((resolve) => {
    const timeout = setTimeout(
      () => {
        resolve({ kind: "pending" });
      },
      Math.max(0, timeoutMs)
    );
    task.then(
      () => {
        clearTimeout(timeout);
        resolve({ kind: "settled" });
      },
      (error: unknown) => {
        clearTimeout(timeout);
        resolve({ error, kind: "failed" });
      }
    );
  });
}

interface StartInput {
  readonly contentId?: ContentId;
  readonly expectedGeneration: number;
  readonly installationId: InstallationId;
  readonly mode?: "user" | "automatic";
  readonly signal?: AbortSignal;
}

async function attempt(
  operation: () => Promise<void>,
  failures: unknown[]
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}

function supervisorError(
  code: ModuleProgramSupervisorErrorCode,
  message: string,
  cause?: unknown
): ModuleProgramSupervisorError {
  return new ModuleProgramSupervisorError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function startupFailureMessage(
  installationId: InstallationId,
  error: unknown
): string {
  const messages: string[] = [];
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.message && !messages.includes(current.message)) {
      messages.push(current.message);
    }
    current = current.cause;
  }
  const detail =
    messages.join(": ") ||
    (typeof error === "string" && error.length > 0 ? error : "unknown error");
  return `Could not start Installation ${installationId}: ${detail}`;
}
