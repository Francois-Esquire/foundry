import type { RunEvent, RunEventType, RunRecord, RunStatus } from "./schema";
import type { WorkflowStoreWrite } from "./store/index";

/** The event a Run moving into each status makes, past its filing. */
const ENTERED: Readonly<Record<RunStatus, RunEventType>> = {
  cancelled: "run.cancelled",
  complete: "run.completed",
  failed: "run.failed",
  // A filed Run queued again: its Suspension resolved, or recovery
  // re-queued it after the process running it went away.
  queued: "run.resumed",
  running: "run.started",
  suspended: "run.parked",
};

/**
 * The event one change to a Run makes, from the Run as it was (`null`: not
 * filed yet) to the Run as the change leaves it (`null`: deleted). A change
 * that leaves the Run's status as it was makes none: a patch of its
 * snapshot, output or tags is step progress, not a lifecycle change.
 */
export function runEvent(
  before: RunRecord | null,
  after: RunRecord | null
): RunEvent | undefined {
  if (after === null) {
    return before === null ? undefined : event("run.removed", before);
  }
  if (before === null) {
    return event("run.queued", after);
  }
  if (before.status === after.status) {
    return;
  }
  return event(ENTERED[after.status], after);
}

/** `write` carrying `events`, the ones present, in order; left without the field when none is. */
export function withEvents(
  write: WorkflowStoreWrite,
  ...events: readonly (RunEvent | undefined)[]
): WorkflowStoreWrite {
  const made = events.filter((item): item is RunEvent => item !== undefined);
  return made.length === 0 ? write : { ...write, events: made };
}

function event(type: RunEventType, run: RunRecord): RunEvent {
  return {
    at: new Date().toISOString(),
    id: crypto.randomUUID(),
    queueId: run.queueId,
    runId: run.id,
    type,
  };
}
