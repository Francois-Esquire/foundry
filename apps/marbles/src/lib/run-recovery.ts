import type { ExecutionRun } from "~/lib/execution-record";
import { SETTLED_EXECUTION_STATUSES } from "~/lib/execution-statuses";
import type { RunStore } from "~/lib/run-store";
import type { WorkflowQueue } from "~/lib/workflow-queue";
import type { RunReads } from "~/lib/workflow-runs";
import { readRun, readRuns } from "~/lib/workflow-runs";

export async function workflowStatuses(
  store: Pick<RunReads, "getJob" | "getRun">,
  executions: readonly ExecutionRun[]
): Promise<ReadonlyMap<string, string>> {
  const statuses = new Map<string, string>();
  for (const execution of executions) {
    if (
      execution.kind !== "workflow" ||
      SETTLED_EXECUTION_STATUSES.has(execution.status)
    ) {
      continue;
    }
    const run = await readRun(store, execution.id);
    if (run !== null) {
      statuses.set(run.id, run.status);
    }
  }
  return statuses;
}

function abandonedBecause(execution: ExecutionRun): {
  readonly message: string;
  readonly name: string;
} {
  if (execution.status === "cancelled") {
    return {
      message: "it was cancelled after its process exited",
      name: "Cancelled",
    };
  }
  return {
    message:
      execution.error?.message ?? "its process exited while it was running",
    name: "Interrupted",
  };
}

export interface AbandonedRunsOptions {
  readonly execution: (runId: string) => ExecutionRun | undefined;
  readonly print: (line: string) => void;
  readonly queue: Pick<WorkflowQueue, "abandonRun">;
  readonly runs: RunStore;
  readonly store: Pick<RunReads, "listJobs" | "listRuns">;
}

export async function closeAbandonedRuns(
  options: AbandonedRunsOptions
): Promise<readonly string[]> {
  const closed: string[] = [];
  if (!options.runs.durable) {
    return closed;
  }
  for (const run of await readRuns(options.store, ["queued", "running"])) {
    const held = options.execution(run.id);
    const read: { settled?: ExecutionRun } = {};
    const claimed = await options.runs.claim(run.id, (stored, execution) => {
      const open = stored?.status === "queued" || stored?.status === "running";
      const seen = execution ?? held;
      if (open && seen && SETTLED_EXECUTION_STATUSES.has(seen.status)) {
        read.settled = seen;
        return true;
      }
      return false;
    });
    const { settled } = read;
    if (!(claimed && settled)) {
      continue;
    }
    try {
      const why = abandonedBecause(settled);
      await options.queue.abandonRun(run.id, why);
      options.print(`[run] ${run.step} ${run.id} closed out: ${why.message}`);
      closed.push(run.id);
    } finally {
      await options.runs.release(run.id);
    }
  }
  return closed;
}
