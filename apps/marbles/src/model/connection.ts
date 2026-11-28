import type { ChannelMessage } from "@foundry/workflows/channels";
import type { InputValues } from "~/lib/definitions/inputs";
import type { DefinitionEntry } from "~/lib/definitions/registry";
import type { SessionRef } from "~/lib/definitions/types";
import type { FeedAnswer } from "~/lib/feed/entry";
import type { TerminalStatus } from "~/lib/runs/output";
import type { StepInput } from "~/lib/runs/step-work";
import type { MonitorSpec } from "~/lib/schedule/monitor";
import type { Schedule, Trigger } from "~/lib/schedule/triggers";
import type { DashboardSnapshot } from "~/model/dashboard";
import type {
  TaskCommand,
  TaskCommandKind,
  TaskCommandResult,
} from "~/model/tasks";

export type WorkspaceState =
  | "starting"
  | "ready"
  | "reloading"
  | "failed"
  | "stopped";

export interface WorkspaceSummary {
  readonly config: string | null;
  readonly error?: string;
  readonly id: string;
  readonly pid?: number;
  readonly root: string;
  readonly state: WorkspaceState;
}

export interface RunControls {
  cancel(runId: string): Promise<void>;
  deleteTrigger(id: string): Promise<void>;
  pause(runId: string, stepId: string): Promise<void>;
  resume(runId: string, stepId: string, prompt?: string): Promise<void>;
  send(runId: string, stepId: string, input: StepInput): Promise<void>;
  setTriggerEnabled(id: string, enabled: boolean): Promise<void>;
  steer(runId: string, stepId: string, prompt: string): Promise<void>;
  stopActivity(sessionId: string, id: string): Promise<void>;
  stream?(
    runId: string,
    signal?: AbortSignal
  ): ReadableStream<ChannelMessage> | undefined;
}

export interface WorkspaceActions {
  answer(entryId: string, answer: FeedAnswer): Promise<void>;
  launch(name: string, input: InputValues | undefined): Promise<string>;
  readonly runs: RunControls;
}

export interface WorkspaceConfig {
  readonly agents: readonly {
    readonly id: string;
    readonly model?: string;
    readonly provider?: string;
  }[];
  readonly definitions: readonly DefinitionEntry[];
  readonly monitors: readonly {
    readonly key: string;
    readonly label?: string;
    readonly source: MonitorSpec;
    readonly trigger: Trigger;
  }[];
  readonly observers: readonly ObserverEntry[];
  readonly root: string;
  readonly schedules: readonly Schedule[];
  readonly source: string | null;
}

export interface ObserverEntry {
  readonly name: string;
  readonly source: string;
  readonly types?: readonly string[];
}

export interface DispatchOptions {
  readonly agent?: string;
  readonly compaction?: boolean;
  readonly cwd?: string;
  readonly instructions?: string;
  readonly maxTurns?: number;
  readonly model?: string;
  readonly prompt: string;
  readonly provider?: string;
  readonly session?: SessionRef;
  readonly timeoutMs?: number;
}

type RunInfoStatus = TerminalStatus | "queued" | "running" | "suspended";

export interface RunInfo {
  endedAt?: string;
  error?: string;
  readonly kind: "agent" | "workflow";
  readonly name: string;
  output?: unknown;
  queuedAt?: string;
  readonly runId: string;
  readonly session?: SessionRef;
  startedAt?: string;
  readonly status: RunInfoStatus;
  text?: string;
}

export interface RunSummary {
  readonly endedAt?: string;
  readonly error?: string;
  readonly id: string;
  readonly kind: "agent" | "workflow";
  readonly name: string;
  readonly queuedAt: string;
  readonly session?: SessionRef;
  readonly startedAt?: string;
  readonly status: RunInfoStatus;
}

export interface RunListQuery {
  readonly cursor?: number;
  readonly kind?: "agent" | "workflow";
  readonly limit?: number;
  readonly name?: string;
  readonly status?: readonly RunInfoStatus[];
}

export interface RunPage {
  readonly items: readonly RunSummary[];
  readonly nextCursor?: number;
  readonly total: number;
}

export type DispatchInfo = Pick<
  RunInfo,
  "kind" | "name" | "runId" | "session" | "status"
>;

export interface EnqueueOptions {
  readonly key?: string;
}

export interface RollResult {
  readonly lines: readonly string[];
  readonly skipped?: string;
  readonly value?: unknown;
}

export interface WorkspaceConnection {
  readonly actions: WorkspaceActions;
  cancelRun(runId: string): Promise<RunInfo>;
  readonly config: string | null;
  describe(): Promise<WorkspaceConfig>;
  dispatchAgent(options: DispatchOptions): Promise<DispatchInfo>;
  dispatchWorkflow(
    name: string,
    input: unknown,
    options?: EnqueueOptions
  ): Promise<DispatchInfo>;
  getRun(runId: string): Promise<RunInfo>;
  readonly id: string;
  listRuns(query?: RunListQuery): Promise<RunPage>;
  roll(name: string, input?: unknown): Promise<RollResult>;
  readonly root: string;
  snapshot(): Promise<DashboardSnapshot>;
  tasks<K extends TaskCommandKind>(
    command: TaskCommand<K>
  ): Promise<TaskCommandResult<K>>;
}
