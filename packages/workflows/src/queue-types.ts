import type { SuspensionState } from "./channels";
import type { DirectRunLinks, UpdateRunInput } from "./execution-commands";
import type { OrchestratorStore } from "./execution-coordinator";
import type { Extensions } from "./extensions";
import type { OrchestratorLogger } from "./logger";
import type { DefinitionReference } from "./schema";
import type { RunStatus } from "./types";

export interface QueueOptions {
  readonly concurrency: number;
  readonly extensions?: Extensions;
  readonly id?: string;
  readonly logger?: OrchestratorLogger;
  /** @internal Atomically cancel the Run and every pending Suspension. */
  readonly onRunCancelled?: (
    runId: string,
    runPatch: Omit<UpdateRunInput, "status">
  ) => Promise<void>;
  /** @internal Persist first-class authority before exposing a parked Run. */
  readonly onRunSuspended?: (
    runId: string,
    step: string,
    suspension: SuspensionState,
    runPatch: Omit<UpdateRunInput, "status">
  ) => Promise<void>;
  readonly store?: OrchestratorStore;
}

export interface DispatchOptions {
  readonly definition?: DefinitionReference;
  readonly extensions?: Extensions;
  readonly links?: DirectRunLinks;
  readonly metadata?: Record<string, unknown>;
  readonly runId?: string;
  readonly step?: string;
}

export interface QueueSize {
  readonly active: number;
  readonly cancelled: number;
  readonly complete: number;
  readonly failed: number;
  readonly pending: number;
  readonly suspended: number;
}

export type { RecoverableRun } from "./execution-commands";

export type QueueEvent =
  | "dispatched"
  | "started"
  | "complete"
  | "failed"
  | "suspended"
  | "resumed"
  | "cancelled"
  | "persist_failed"
  | "restarted"
  | "queue_failed";

export interface QueueEventPayload {
  readonly at: string;
  readonly error?: { readonly name: string; readonly message: string };
  readonly payload?: unknown;
  readonly runId: string;
  readonly status: RunStatus;
  readonly step: string;
}
