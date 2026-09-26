import type { LogEntry } from "~/components/ui/log";
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

export interface DefinitionSnapshot extends DefinitionOptions {
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

export interface FeedMediaSnapshot {
  /** Loaded for images only, which the reader draws inline. */
  readonly bytes?: Uint8Array;
  readonly kind: "image" | "video" | "audio" | "file";
  readonly name: string;
  /** Path inside the entry, as the markdown references it. */
  readonly path: string;
}

export interface FeedEntrySnapshot {
  /** Set on results that carry an artifact version. */
  readonly artifact?: {
    readonly artifactId: string;
    readonly contentId: string;
  };
  /** Markdown article, starting with the entry's title as a heading. */
  readonly body: string;
  readonly definition: string;
  readonly id: string;
  /** Set on `input` entries: a paused run waiting for this answer. */
  readonly input?: {
    readonly answer?: string;
    readonly choices: readonly string[];
    /** An approval blocks its run; a question is input. */
    readonly mode?: "question" | "approval";
    /** Given with the answer to an approval. */
    readonly note?: string;
    readonly status: "open" | "answered" | "cancelled";
  };
  readonly kind: "result" | "milestone" | "input";
  readonly media: readonly FeedMediaSnapshot[];
  /** Display time, formatted by the host. */
  readonly posted: string;
  /** ISO time of the first post; entries sort newest first by it. */
  readonly postedAt: string;
  readonly run: string;
  readonly step: string;
  readonly title: string;
  readonly workspace: { readonly id: string; readonly name: string };
}

/** Presentation data only. No runtime handles, stores, or API clients. */
export interface DashboardSnapshot {
  readonly definitions: readonly DefinitionSnapshot[];
  /** Entries from every workspace, newest first; the view filters by workspace. */
  readonly feed: readonly FeedEntrySnapshot[];
  readonly harnesses: readonly string[];
  readonly mode: "snapshot" | "live";
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
