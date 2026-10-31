import { TERMINAL_RUN_STATUSES } from "~/lib/state/runs";

/**
 * What the views make of a status: the groups that decide which controls a
 * run offers, and the label and tone it is shown with. Settled is the
 * engine's own set; `paused` and `skipped` are what the dashboard snapshot
 * adds for steps.
 */

export type RunStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "suspended"
  | "paused"
  | "skipped";

/** An open live feed input a run, step, or activity is waiting on. */
export type InputAttention = "approval" | "question";

/** The colour family a status reads in; StatusLabel maps it to the theme. */
export type StatusTone = "neutral" | "info" | "success" | "warning" | "error";

const ACTIVE: ReadonlySet<string> = new Set(["queued", "running", "suspended"]);
const PAUSED: ReadonlySet<string> = new Set(["suspended", "paused"]);

/** Settled for good: nothing will run, resume, or need cancelling. */
export function isTerminal(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** Still occupying its trigger: queued, running, or waiting to resume. */
export function isActive(status: string): boolean {
  return ACTIVE.has(status);
}

/** Parked, and resumable with an optional prompt. */
export function isPaused(status: string): boolean {
  return PAUSED.has(status);
}

const TONES: Readonly<Record<string, StatusTone>> = {
  complete: "success",
  failed: "error",
  running: "info",
};

/** Attention outranks the runtime status, which execution controls still use. */
export function statusDisplay(item: {
  readonly attention?: InputAttention;
  readonly status: string;
}): { readonly label: string; readonly tone: StatusTone } {
  if (item.attention === "approval") {
    return { label: "Waiting for approval", tone: "warning" };
  }
  if (item.attention === "question") {
    return { label: "Waiting for answer", tone: "warning" };
  }
  return { label: item.status, tone: TONES[item.status] ?? "neutral" };
}
