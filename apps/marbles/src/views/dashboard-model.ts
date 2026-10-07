import type { FeedEntrySnapshot } from "~/lib/feed/read";
import type { DefinitionOptions } from "~/lib/inputs";
import type { JsonValue } from "~/model/json";
import type { LogEntry } from "~/model/log";
import type { InputAttention, RunStatus } from "./run-status";

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
  readonly mode: "snapshot" | "live";
  readonly notices?: readonly string[];
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

/** What a selection points at in one snapshot. */
export type ResolvedSelection =
  | { readonly kind: "none" }
  /** Selected earlier, and missing from this snapshot; `run` when only its step or activity is. */
  | {
      readonly kind: "gone";
      readonly selection: DashboardSelection;
      readonly run?: RunSnapshot;
    }
  | { readonly kind: "trigger"; readonly trigger: TriggerSnapshot }
  | { readonly kind: "definition"; readonly definition: DefinitionSnapshot }
  /** A run, or one of its steps: `path` runs from a top-level step down to it. */
  | {
      readonly kind: "run";
      readonly run: RunSnapshot;
      readonly path: readonly StepSnapshot[];
    }
  | {
      readonly kind: "activity";
      readonly run: RunSnapshot;
      readonly activity: HarnessActivitySnapshot;
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

function stepPath(
  steps: readonly StepSnapshot[],
  id: string
): readonly StepSnapshot[] {
  for (const step of steps) {
    if (step.id === id) {
      return [step];
    }
    const children = stepPath(step.children, id);
    if (children.length) {
      return [step, ...children];
    }
  }
  return [];
}

function resolveRun(
  run: RunSnapshot,
  selection: Extract<DashboardSelection, { kind: "run" }>
): ResolvedSelection {
  if (selection.activityId !== undefined) {
    const activity = run.activities?.find(
      (item) =>
        item.id === selection.activityId &&
        item.sessionId === selection.sessionId
    );
    return activity
      ? { activity, kind: "activity", run }
      : { kind: "gone", run, selection };
  }
  if (selection.stepId === undefined) {
    return { kind: "run", path: [], run };
  }
  const path = stepPath(run.steps, selection.stepId);
  return path.length
    ? { kind: "run", path, run }
    : { kind: "gone", run, selection };
}

/** Look a selection up once; every view and command reads the result. */
export function resolveSelection(
  snapshot: DashboardSnapshot,
  selection: DashboardSelection | undefined
): ResolvedSelection {
  if (!selection) {
    return { kind: "none" };
  }
  if (selection.kind === "trigger") {
    const trigger = snapshot.triggers.find((item) => item.id === selection.id);
    return trigger ? { kind: "trigger", trigger } : { kind: "gone", selection };
  }
  if (selection.kind === "definition") {
    const definition = snapshot.definitions.find(
      (item) => item.id === selection.id
    );
    return definition
      ? { definition, kind: "definition" }
      : { kind: "gone", selection };
  }
  const run = snapshot.runs.find((item) => item.id === selection.id);
  return run ? resolveRun(run, selection) : { kind: "gone", selection };
}

/**
 * The step a run control applies to: the selected step, else the run's root,
 * whose frame is keyed by the definition's name.
 */
export function actionTarget(
  resolved: Extract<ResolvedSelection, { kind: "run" }>
): { readonly stepId: string; readonly status: string } {
  const step = resolved.path.at(-1);
  return step
    ? { status: step.status, stepId: step.id }
    : { status: resolved.run.status, stepId: resolved.run.definitionId };
}

export function canStopActivity(activity: HarnessActivitySnapshot): boolean {
  return (
    activity.actions?.includes("stop") === true &&
    (activity.status === "running" || activity.status === "waiting")
  );
}
