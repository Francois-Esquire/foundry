import { EventEmitter } from "node:events";

import type {
  ModuleRecoveryResult,
  ModuleRuntimeRecovery,
} from "../platform/runtime-recovery";

export type ModuleApplicationRecoveryPhase =
  | "pending"
  | "normalizing"
  | "recovering"
  | "settled"
  | "failed"
  | "stopping";

export interface ModuleApplicationRecoveryOutcome {
  readonly error: string | null;
  readonly installationId: string;
  readonly kind: ModuleRecoveryResult["kind"];
}

export interface ModuleApplicationRecoverySnapshot {
  readonly failure: string | null;
  readonly outcomes: readonly ModuleApplicationRecoveryOutcome[];
  readonly phase: ModuleApplicationRecoveryPhase;
  readonly revision: number;
}

/**
 * Application-level owner for Module normalization and automatic starts.
 * `start()` only schedules work: host readiness never awaits this campaign.
 */
export class ModuleApplicationRecovery {
  readonly #events = new EventEmitter();
  readonly #normalized: Promise<void>;
  #resolveNormalized!: () => void;
  #rejectNormalized!: (error: unknown) => void;
  #normalizationSettled = false;
  #snapshot: ModuleApplicationRecoverySnapshot = Object.freeze({
    failure: null,
    outcomes: Object.freeze([]),
    phase: "pending",
    revision: 0,
  });
  #task: Promise<void> | undefined;
  readonly #campaignAbort = new AbortController();
  private readonly recovery: ModuleRuntimeRecovery;

  constructor(recovery: ModuleRuntimeRecovery) {
    this.recovery = recovery;
    this.#normalized = new Promise<void>((resolve, reject) => {
      this.#resolveNormalized = resolve;
      this.#rejectNormalized = reject;
    });
    // The gate can reject before a mutation observes it; ownership of that
    // rejection stays here so it never becomes an unhandled process error.
    this.#normalized.catch(() => undefined);
  }

  snapshot(): ModuleApplicationRecoverySnapshot {
    return this.#snapshot;
  }

  changes(): EventEmitter {
    return this.#events;
  }

  /** Mutations wait only for persisted-state normalization, not auto-starts. */
  whenNormalized(): Promise<void> {
    return this.#normalized;
  }

  start(): void {
    if (this.#task !== undefined) {
      return;
    }
    this.#task = this.#run();
    this.#task.catch(() => undefined);
  }

  async shutdown(reason: string): Promise<void> {
    this.#publish("stopping", this.#snapshot.outcomes, null);
    this.#campaignAbort.abort(new Error("Host is shutting down"));
    // The campaign is finite and every Program stop has its own observation
    // bound. Waiting here prevents an automatic start from racing releaseAll.
    await this.#task?.catch(() => undefined);
    await this.recovery.releaseAll(reason);
  }

  async #run(): Promise<void> {
    try {
      this.#publish("normalizing", [], null);
      await this.recovery.normalizeInterrupted();
      this.#normalizationSettled = true;
      this.#resolveNormalized();
      this.#publish("recovering", [], null);
      const outcomes = await this.recovery.recoverEnabled({
        signal: this.#campaignAbort.signal,
      });
      this.#publish("settled", outcomes.map(publicOutcome), null);
    } catch (error) {
      if (!this.#normalizationSettled) {
        this.#normalizationSettled = true;
        this.#rejectNormalized(error);
      }
      this.#publish("failed", [], errorMessage(error));
      throw error;
    }
  }

  #publish(
    phase: ModuleApplicationRecoveryPhase,
    outcomes: readonly ModuleApplicationRecoveryOutcome[],
    failure: string | null
  ): void {
    this.#snapshot = Object.freeze({
      failure,
      outcomes: Object.freeze([...outcomes]),
      phase,
      revision: this.#snapshot.revision + 1,
    });
    this.#events.emit("change", this.#snapshot);
  }
}

function publicOutcome(
  result: ModuleRecoveryResult
): ModuleApplicationRecoveryOutcome {
  return Object.freeze({
    error: result.kind === "failed" ? result.error.message : null,
    installationId: result.installationId,
    kind: result.kind,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
