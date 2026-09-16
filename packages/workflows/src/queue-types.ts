import type { SuspensionState } from "./channels";
import type { OrchestratorLogger } from "./logger";
import type {
  DefinitionReference,
  DirectRunLinks,
  Extensions,
  OrchestratorStore,
  UpdateRunInput,
} from "./store";
import type { RunStatus } from "./types";

export interface QueueOptions {
  /** Maximum simultaneous in-flight runs. */
  readonly concurrency: number;
  /** Host-owned JSON-safe annotations persisted with the queue. */
  readonly extensions?: Extensions;
  /** Pre-existing queue id. When omitted, a fresh `qu_*` is generated.
   * Pass an id to attach to an existing queue row across restarts. */
  readonly id?: string;
  /** Optional lifecycle logger. */
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
  /** Persistence boundary. Defaults to an in-memory store. */
  readonly store?: OrchestratorStore;
}

export interface DispatchOptions {
  /** Registered definition used to reconstruct this Run. */
  readonly definition?: DefinitionReference;
  /** Host-owned JSON-safe annotations persisted with the run. */
  readonly extensions?: Extensions;
  /** Cross-domain correlation and provenance links for this Run. */
  readonly links?: DirectRunLinks;
  /** Free-form metadata persisted alongside the snapshot. */
  readonly metadata?: Record<string, unknown>;
  /** Caller-supplied Run identity. Queue generates rn-* when omitted. */
  readonly runId?: string;
  /** Override the persisted runs.step (defaults to workflow.name).
   * Orchestrator threads its registry key here so cold-start recovery
   * looks up the run by the same name it was dispatched under. */
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

export type { RecoverableRun } from "./store";

export type QueueEvent =
  // Per-run lifecycle.
  | "dispatched"
  | "started"
  | "complete"
  | "failed"
  | "suspended"
  | "resumed"
  | "cancelled"
  // Queue-level surfaces. `runId` carries the queue id, `step` is empty,
  // `error` is set.
  | "persist_failed"
  | "restarted"
  | "queue_failed";

export interface QueueEventPayload {
  readonly at: string;
  /** Set on queue-level failure events (persist_failed, restarted, queue_failed). */
  readonly error?: { readonly name: string; readonly message: string };
  readonly payload?: unknown;
  readonly runId: string;
  readonly status: RunStatus;
  readonly step: string;
}
