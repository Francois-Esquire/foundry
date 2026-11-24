import type { ExecutionRun } from "~/lib/execution-record";
import { SETTLED_EXECUTION_STATUSES } from "~/lib/execution-statuses";
import type { RecordedScope } from "~/lib/run-scope";
import type { RunStore } from "~/lib/run-store";
import type { WorkflowQueue } from "~/lib/workflow-queue";
import type { RunReads, RunRecord } from "~/lib/workflow-runs";
import { readRun, readRuns } from "~/lib/workflow-runs";

export interface SuspendedRunsOptions {
  readonly askable: boolean;
  readonly print: (line: string) => void;
  readonly registered: (name: string) => boolean;
  readonly runs: RunStore;
  readonly settled: (runId: string) => Promise<boolean>;
  readonly store: Pick<RunReads, "listJobs" | "listRuns">;
}

export async function adoptSuspendedRuns(
  options: SuspendedRunsOptions
): Promise<ReadonlyMap<string, RecordedScope>> {
  const adopted = new Map<string, RecordedScope>();
  if (!options.runs.durable) {
    return adopted;
  }
  for (const run of await readRuns(options.store, ["suspended"])) {
    const scope = await adoptSuspendedRun(run, options);
    if (scope !== undefined) {
      adopted.set(run.id, scope);
    }
  }
  return adopted;
}

export async function adoptSuspendedRun(
  run: RunRecord,
  { askable, print, registered, runs, settled }: SuspendedRunsOptions
): Promise<RecordedScope | undefined> {
  const passed = (why: string): undefined => {
    print(`[run] ${run.step} ${run.id} not adopted: ${why}`);
  };
  if (!(askable && registered(run.step))) {
    return passed("nothing here can resume it");
  }
  let refused: string | undefined;
  let sawExecution = false;
  const claimed = await runs.claim(run.id, (stored, execution) => {
    if (stored?.status !== "suspended") {
      refused = `it is ${stored === null ? "gone" : stored.status} now, not suspended`;
      return false;
    }
    sawExecution = execution !== undefined && execution !== null;
    if (execution && SETTLED_EXECUTION_STATUSES.has(execution.status)) {
      refused = "its execution run has settled";
      return false;
    }
    return true;
  });
  if (!claimed) {
    return passed(refused ?? "another live engine owns it");
  }
  try {
    if (!sawExecution && (await settled(run.id))) {
      await runs.release(run.id);
      return passed("its execution run has settled");
    }
    const recorded = await runs.recorded(run.id);
    return {
      ledger: recorded.ledger,
      session: { id: recorded.session ?? crypto.randomUUID() },
      ...(recorded.literals === undefined
        ? {}
        : { literals: recorded.literals }),
    };
  } catch (error) {
    await runs.release(run.id).catch(() => undefined);
    throw error;
  }
}

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
