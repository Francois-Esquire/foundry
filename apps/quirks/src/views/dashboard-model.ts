import type { LogEntry } from "~/components/ui/log";

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

export interface TriggerSnapshot {
  readonly configuration?: JsonValue;
  readonly description: string;
  readonly id: string;
  readonly kind: "schedule" | "monitor";
  readonly name: string;
  readonly next?: string;
  readonly status: "waiting" | "watching" | "running" | "failed";
  readonly targetId: string;
}

export interface DefinitionSnapshot {
  readonly description: string;
  readonly id: string;
  readonly kind: "workflow" | "step";
  readonly name: string;
}

/** An observed step instance, including children discovered during execution. */
export interface StepSnapshot {
  readonly children: readonly StepSnapshot[];
  readonly elapsed?: string;
  readonly error?: string;
  readonly id: string;
  readonly input?: JsonValue;
  readonly name: string;
  readonly result?: JsonValue;
  readonly status: RunStatus;
}

export interface RunSnapshot {
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
  readonly harnesses: readonly string[];
  readonly mode: "snapshot" | "live";
  readonly root: string;
  readonly runs: readonly RunSnapshot[];
  readonly status: string;
  readonly triggers: readonly TriggerSnapshot[];
  readonly workspace: string;
}

export type DashboardSelection =
  | { readonly kind: "trigger"; readonly id: string }
  | { readonly kind: "definition"; readonly id: string }
  | { readonly kind: "run"; readonly id: string; readonly stepId?: string };

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
  if (selection.kind === "run" && selection.stepId) {
    return `run:${selection.id}:step:${selection.stepId}`;
  }
  return `${selection.kind}:${selection.id}`;
}
