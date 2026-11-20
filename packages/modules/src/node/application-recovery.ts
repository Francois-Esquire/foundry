import { EventEmitter } from "node:events";

import type { Installation } from "../domain";
import type { ModuleProgramLaunch } from "../platform/contracts";
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
  readonly #launch: (
    installation: Installation
  ) => Promise<ModuleProgramLaunch>;

  constructor(
    recovery: ModuleRuntimeRecovery,
    launch: (installation: Installation) => Promise<ModuleProgramLaunch>
  ) {
    this.recovery = recovery;
    this.#launch = launch;
    this.#normalized = new Promise<void>((resolve, reject) => {
      this.#resolveNormalized = resolve;
      this.#rejectNormalized = reject;
    });
    this.#normalized.catch(() => undefined);
  }

  snapshot(): ModuleApplicationRecoverySnapshot {
    return this.#snapshot;
  }

  changes(): EventEmitter {
    return this.#events;
  }

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
        launch: this.#launch,
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
