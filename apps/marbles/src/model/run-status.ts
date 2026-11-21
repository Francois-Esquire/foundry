import type { TerminalRunStatus } from "~/lib/run-store";

export type RunStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "suspended"
  | "paused"
  | "skipped";

export type InputAttention = "approval" | "question";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "error";

const ACTIVE: ReadonlySet<string> = new Set(["queued", "running", "suspended"]);
const PAUSED: ReadonlySet<string> = new Set(["suspended", "paused"]);
const TERMINAL: Readonly<Record<TerminalRunStatus, true>> = {
  cancelled: true,
  complete: true,
  failed: true,
};

export function isTerminal(status: string): boolean {
  return Object.hasOwn(TERMINAL, status);
}

export function isActive(status: string): boolean {
  return ACTIVE.has(status);
}

export function isPaused(status: string): boolean {
  return PAUSED.has(status);
}

const TONES: Readonly<Record<string, StatusTone>> = {
  complete: "success",
  failed: "error",
  running: "info",
};

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
