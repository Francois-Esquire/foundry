/**
 * The statuses an Execution Run moves through, on their own so a host can
 * read them (`@foundry.sh/marbles/statuses`) without loading the engine: a
 * renderer, or main-process code a renderer test also loads.
 */

/** Every status, in lifecycle order. */
export const EXECUTION_STATUSES = [
  "queued",
  "running",
  "suspended",
  "complete",
  "failed",
  "cancelled",
  /** It was running when its process died; nothing replays it. */
  "interrupted",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** Statuses a run never leaves. */
export const SETTLED_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set(
  ["complete", "failed", "cancelled", "interrupted"]
);
