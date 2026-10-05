import type { LogEntry } from "~/components/ui/log";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import type { DefinitionOptions } from "~/lib/inputs";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ItemKind = "schedule" | "monitor" | "workflow" | "step";
type RunStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "suspended"
  | "paused"
  | "skipped";

export type InputAttention = "approval" | "question";

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

export interface DefinitionSnapshot extends DefinitionOptions {
  readonly description: string;
  readonly id: string;
  readonly kind: "workflow" | "step";
  readonly name: string;
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
  readonly triggerId?: string;
}

/** Presentation data only. No runtime handles, stores, or API clients. */
export interface DashboardSnapshot {
  readonly definitions: readonly DefinitionSnapshot[];
  /** Entries from every workspace, newest first; the view filters by workspace. */
  readonly feed: readonly FeedEntrySnapshot[];
  readonly harnesses: readonly string[];
  readonly mode: "snapshot" | "live";
  readonly notices?: readonly string[];
  readonly root: string;
  readonly runs: readonly RunSnapshot[];
  readonly status: string;
  readonly triggers: readonly TriggerSnapshot[];
  readonly workspace: string;
  /** This workspace's feed id, so the view can offer "this workspace". */
  readonly workspaceId?: string;
}

export type DashboardSelection =
  | { readonly kind: "trigger"; readonly id: string }
  | { readonly kind: "definition"; readonly id: string }
  | {
      readonly kind: "run";
      readonly id: string;
      readonly stepId?: string;
      readonly activityId?: string;
      readonly sessionId?: string;
    };

export function flattenSteps(
  steps: readonly StepSnapshot[],
  depth = 0
): { step: StepSnapshot; depth: number }[] {
  return steps.flatMap((step) => [
    { depth, step },
    ...flattenSteps(step.children, depth + 1),
  ]);
}

export function selectionKey(selection: DashboardSelection): string {
  if (selection.kind === "run" && selection.activityId !== undefined) {
    return `run:${selection.id}:activity:${JSON.stringify([selection.sessionId, selection.activityId])}`;
  }
  if (selection.kind === "run" && selection.stepId) {
    return `run:${selection.id}:step:${selection.stepId}`;
  }
  return `${selection.kind}:${selection.id}`;
}

/** Display attention without replacing the status used by execution controls. */
export function runStatusLabel(item: {
  readonly attention?: InputAttention;
  readonly status: string;
}): string {
  if (item.attention === "approval") {
    return "Waiting for approval";
  }
  if (item.attention === "question") {
    return "Waiting for answer";
  }
  return item.status;
}

export function selectedActivity(
  run: RunSnapshot,
  selection: DashboardSelection
): HarnessActivitySnapshot | undefined {
  if (selection.kind !== "run" || selection.activityId === undefined) {
    return undefined;
  }
  return run.activities?.find(
    (activity) =>
      activity.id === selection.activityId &&
      activity.sessionId === selection.sessionId
  );
}

export function canStopActivity(activity: HarnessActivitySnapshot): boolean {
  return (
    activity.actions?.includes("stop") === true &&
    (activity.status === "running" || activity.status === "waiting")
  );
}
