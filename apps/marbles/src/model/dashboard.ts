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
  readonly workspace?: OwnerWorkspace;
}

export interface OwnerWorkspace {
  readonly id: string;
  readonly name: string;
}

export interface CatalogOrigin {
  readonly external: boolean;
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

export interface StepSnapshot {
  readonly attention?: InputAttention;
  readonly children: readonly StepSnapshot[];
  readonly elapsed?: string;
  readonly error?: string;
  readonly id: string;
  readonly input?: JsonValue;
  readonly name: string;
  readonly result?: JsonValue;
  readonly status: RunStatus;
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
  readonly timing?: {
    readonly createdAt: number;
    readonly endedAt?: number;
    readonly startedAt?: number;
  };
  readonly triggerId?: string;
  readonly usage?: UsageTotal;
  readonly workspace?: OwnerWorkspace;
  readonly workspaces?: readonly string[];
}

export interface DashboardSnapshot {
  readonly definitions: readonly DefinitionSnapshot[];
  readonly diagnostics?: readonly LogEntry[];
  readonly feed: readonly FeedEntrySnapshot[];
  readonly mode: "snapshot" | "live";
  readonly notices?: readonly string[];
  readonly runs: readonly RunSnapshot[];
  readonly settings?: SettingsSnapshot;
  readonly setupLogs?: readonly SetupLogEntry[];
  readonly status: string;
  readonly triggers: readonly TriggerSnapshot[];
  readonly usage?: WorkspaceUsage;
  readonly workspace: string;
  readonly workspaceId?: string;
}
