import type { RunFact, RunFactType, RunRecord, RunStatus } from "./schema";
import type { WorkflowStoreWrite } from "./store/index";

/** The fact a Run moving into each status makes, past its filing. */
const ENTERED: Readonly<Record<RunStatus, RunFactType>> = {
  cancelled: "run.cancelled",
  complete: "run.completed",
  failed: "run.failed",
  // A filed Run is only queued again once its Suspension resolves.
  queued: "run.resumed",
  running: "run.started",
  suspended: "run.parked",
};

/**
 * The fact one change to a Run makes, from the Run as it was (`null`: not
 * filed yet) to the Run as the change leaves it (`null`: deleted). A change
 * that leaves the Run's status as it was makes none: a patch of its
 * snapshot, output or tags is step progress, not a lifecycle change.
 */
export function runFact(
  before: RunRecord | null,
  after: RunRecord | null
): RunFact | undefined {
  if (after === null) {
    return before === null ? undefined : fact("run.removed", before);
  }
  if (before === null) {
    return fact("run.queued", after);
  }
  if (before.status === after.status) {
    return;
  }
  return fact(ENTERED[after.status], after);
}

/** `write` carrying `facts`, the ones present, in order; left without the field when none is. */
export function withFacts(
  write: WorkflowStoreWrite,
  ...facts: readonly (RunFact | undefined)[]
): WorkflowStoreWrite {
  const made = facts.filter((item): item is RunFact => item !== undefined);
  return made.length === 0 ? write : { ...write, facts: made };
}

function fact(type: RunFactType, run: RunRecord): RunFact {
  return {
    at: new Date().toISOString(),
    id: `rf-${crypto.randomUUID()}`,
    queueId: run.queueId,
    runId: run.id,
    type,
  };
}
