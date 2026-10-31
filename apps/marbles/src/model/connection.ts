import type { ChannelMessage } from "@foundry/workflows/channels";

import type { FeedAnswer } from "~/lib/feed/entry";
import type { InputValues } from "~/lib/inputs";
import type { MonitorSpec } from "~/lib/monitor";
import type { DefinitionEntry } from "~/lib/registry";
import type { TerminalStatus } from "~/lib/state/output";
import type { Schedule, Trigger } from "~/lib/triggers";
import type { SessionRef } from "~/lib/types";
import type { DashboardSnapshot } from "~/model/dashboard";
import type {
  TaskCommand,
  TaskCommandKind,
  TaskCommandResult,
} from "~/model/tasks";

/**
 * One workspace as a host sees it, wherever its engine runs: in this
 * process (`hostWorkspace`) or in a worker behind the Marbles process
 * (`connect().workspace(id)`). The dashboard, the CLI, and the MCP server
 * are written against this once; every method is asynchronous and every
 * value crosses a process boundary as JSON.
 */

export type WorkspaceState =
  | "starting"
  | "ready"
  | "reloading"
  | "failed"
  | "stopped";

/** A workspace the Marbles process knows, and how its worker is doing. */
export interface WorkspaceSummary {
  /** The authoring source, or null for a workspace without one. */
  readonly config: string | null;
  /** Why the worker failed, when it did. */
  readonly error?: string;
  readonly id: string;
  /** The worker's pid while one runs. */
  readonly pid?: number;
  readonly root: string;
  readonly state: WorkspaceState;
}

/** What the dashboard can do to a live run. None of it is authored code. */
export interface RunControls {
  cancel(runId: string): Promise<void>;
  deleteTrigger(id: string): Promise<void>;
  /** Park a running step; rejects when it is not running there. */
  pause(runId: string, stepId: string): Promise<void>;
  /** Resume a paused step, with a prompt for its agent or without one. */
  resume(runId: string, stepId: string, prompt?: string): Promise<void>;
  setTriggerEnabled(id: string, enabled: boolean): Promise<void>;
  /** Hand a prompt to the agent turn running in a step. */
  steer(runId: string, stepId: string, prompt: string): Promise<void>;
  stopActivity(sessionId: string, id: string): Promise<void>;
  /**
   * A live run's events and chunks; `undefined` once it is not held there.
   * Only an in-process host offers it: a stream does not cross a socket.
   */
  stream?(
    runId: string,
    signal?: AbortSignal
  ): ReadableStream<ChannelMessage> | undefined;
}

export interface WorkspaceActions {
  answer(entryId: string, answer: FeedAnswer): Promise<void>;
  /** Start a definition by name with the launch form's values; resolves to the run id. */
  launch(name: string, input: InputValues | undefined): Promise<string>;
  readonly runs: RunControls;
}

/** What the source declared, as `list_config` reports it. */
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
  readonly root: string;
  readonly schedules: readonly Schedule[];
  readonly source: string | null;
}

/** An agent dispatch, as MCP takes it. The schema in `workspace/dispatch.ts` validates it. */
export interface DispatchOptions {
  readonly agent?: string;
  readonly compaction?: boolean;
  readonly cwd?: string;
  readonly instructions?: string;
  readonly maxTurns?: number;
  readonly model?: string;
  readonly prompt: string;
  readonly provider?: string;
  readonly session?: {
    readonly id: string;
    readonly model?: string;
    readonly provider?: string;
  };
  readonly timeoutMs?: number;
}

export interface RunInfo {
  error?: string;
  readonly kind: "agent" | "workflow";
  readonly name: string;
  output?: unknown;
  readonly runId: string;
  readonly session?: SessionRef;
  readonly status: TerminalStatus | "queued" | "running" | "suspended";
  text?: string;
}

/** A dispatch acknowledges acceptance; `getRun` owns the final result fields. */
export type DispatchInfo = Pick<
  RunInfo,
  "kind" | "name" | "runId" | "session" | "status"
>;

/** What `roll` produced: the value, and the lines printed while it ran. */
export interface RollResult {
  readonly lines: readonly string[];
  /** Absent when a schedule's tick was skipped (its lock was held). */
  readonly value?: unknown;
}

export interface WorkspaceConnection {
  readonly actions: WorkspaceActions;
  cancelRun(runId: string): Promise<RunInfo>;
  readonly config: string | null;
  describe(): Promise<WorkspaceConfig>;
  dispatchAgent(options: DispatchOptions): Promise<DispatchInfo>;
  dispatchWorkflow(name: string, input: unknown): Promise<DispatchInfo>;
  getRun(runId: string): Promise<RunInfo>;
  readonly id: string;
  /** Dispatch one definition or schedule now, as `marbles roll` does. */
  roll(name: string, input?: unknown): Promise<RollResult>;
  readonly root: string;
  snapshot(): Promise<DashboardSnapshot>;
  /**
   * One task command on the workspace's own backlog, the store its builtin
   * `tasks` reach; a refusal rejects with the package's `TaskError`.
   */
  tasks<K extends TaskCommandKind>(
    command: TaskCommand<K>
  ): Promise<TaskCommandResult<K>>;
}
