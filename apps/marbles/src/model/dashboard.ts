import type { FeedEntrySnapshot } from "~/lib/feed/read";
import type { DefinitionOptions } from "~/lib/inputs";
import type { JsonValue } from "~/model/json";
import type { LogEntry, SetupLogEntry } from "~/model/log";
import type { InputAttention, RunStatus } from "~/model/run-status";
import type { SettingsSnapshot } from "~/model/settings";
import type { StepUsage, UsageTotal, WorkspaceUsage } from "~/model/usage";

export type ItemKind = "schedule" | "monitor" | "workflow" | "step";

export interface TriggerSnapshot {
  readonly configuration?: JsonValue;
  readonly description: string;
  readonly id: string;
  readonly kind: "schedule" | "monitor";
  readonly lifetime?: "durable" | "sandbox";
  readonly managed?: boolean;
  readonly name: string;
  readonly next?: string;
  readonly owner?: string;
  readonly status: "waiting" | "watching" | "running" | "failed" | "paused";
  readonly targetId: string;
}

/**
 * Where a definition was built. Every top-level definition the workspace's
 * source declares is available throughout that workspace, and only there.
 */
export interface CatalogOrigin {
  /** Declared outside the workspace root, e.g. a packaged prebuilt the source imported. */
  readonly external: boolean;
  /** `file:line`, relative to the workspace root when inside it. */
  readonly source: string;
  readonly workspaceId?: string;
}

export interface DefinitionSnapshot extends DefinitionOptions {
  readonly description: string;
  readonly id: string;
  readonly kind: "workflow" | "step";
  readonly name: string;
  readonly origin?: CatalogOrigin;
}

/** An observed step instance, including children discovered during execution. */
export interface StepSnapshot {
  /** An open live feed input in this step or a running descendant. */
  readonly attention?: InputAttention;
  readonly children: readonly StepSnapshot[];
  readonly elapsed?: string;
  readonly error?: string;
  readonly id: string;
  readonly input?: JsonValue;
  readonly name: string;
  readonly result?: JsonValue;
  readonly status: RunStatus;
  /** Agent turns recorded in this step, and with its descendants. */
  readonly usage?: StepUsage;
}

export interface HarnessActivitySnapshot {
  readonly actions?: readonly "stop"[];
  readonly agentId: string;
  readonly attention?: InputAttention;
  readonly harness: string;
  readonly id: string;
  readonly kind: "subagent" | "task" | "watch" | "schedule";
  readonly lifetime: "session" | "sandbox";
  readonly nativeId?: string;
  readonly parentId?: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly status:
    | "running"
    | "waiting"
    | "complete"
    | "failed"
    | "cancelled"
    | "unknown";
  readonly stepId?: string;
  readonly summary?: string;
  readonly title: string;
}

export interface RunSnapshot {
  readonly activities?: readonly HarnessActivitySnapshot[];
  /** Human attention derived from open live feed entries, independent of runtime status. */
  readonly attention?: InputAttention;
  readonly definitionId: string;
  readonly elapsed: string;
  readonly error?: string;
  readonly id: string;
  readonly input?: JsonValue;
  readonly logs?: readonly LogEntry[];
  readonly name: string;
  readonly result?: JsonValue;
  readonly started: string;
  readonly status: RunStatus;
  readonly steps: readonly StepSnapshot[];
  /** Separate facts, ms since the epoch: a queued run has not started, a live one has not ended. */
  readonly timing?: {
    readonly createdAt: number;
    readonly endedAt?: number;
    readonly startedAt?: number;
  };
  readonly triggerId?: string;
  /** Every agent turn recorded in the run, nested steps included. */
  readonly usage?: UsageTotal;
}

/** Presentation data only. No runtime handles, stores, or API clients. */
export interface DashboardSnapshot {
  readonly definitions: readonly DefinitionSnapshot[];
  /** The host's own lines (status, warnings, errors), oldest first. */
  readonly diagnostics?: readonly LogEntry[];
  /** Entries from every workspace, newest first; the view filters by workspace. */
  readonly feed: readonly FeedEntrySnapshot[];
  readonly mode: "snapshot" | "live";
  readonly notices?: readonly string[];
  readonly runs: readonly RunSnapshot[];
  /** Global preferences, when the host can change them. */
  readonly settings?: SettingsSnapshot;
  /** Workflow setups' log lines, with their runs, oldest first: no run record keeps them. */
  readonly setupLogs?: readonly SetupLogEntry[];
  readonly status: string;
  readonly triggers: readonly TriggerSnapshot[];
  /** Agent usage across this workspace's recorded runs. */
  readonly usage?: WorkspaceUsage;
  readonly workspace: string;
  /** This workspace's feed id, so the view can offer "this workspace". */
  readonly workspaceId?: string;
}
