export const EXECUTION_STATUSES = [
  "queued",
  "running",
  "suspended",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const SETTLED_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set(
  ["complete", "failed", "cancelled", "interrupted"]
);
