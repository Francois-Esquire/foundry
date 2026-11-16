import type {
  ExecutionCoordinator,
  OrchestratorStore,
} from "@foundry/workflows";
import type { RunRecord } from "@foundry/workflows/schema";

import type { ExecutionRun } from "~/lib/execution-record";
import { SETTLED_EXECUTION_STATUSES } from "~/lib/execution-statuses";
import type { RecordedScope } from "~/lib/run-scope";
import type { RunStore } from "~/lib/run-store";

export interface ParkedRunsOptions {
  readonly askable: boolean;
  readonly print: (line: string) => void;
  readonly registered: (name: string) => boolean;
  readonly runs: RunStore;
  readonly settled: (runId: string) => Promise<boolean>;
  readonly store: Pick<OrchestratorStore, "listRuns">;
}

export async function adoptParkedRuns(
  options: ParkedRunsOptions
): Promise<ReadonlyMap<string, RecordedScope>> {
  const adopted = new Map<string, RecordedScope>();
  if (!options.runs.durable) {
    return adopted;
  }
  for (const run of await parked(options.store)) {
    const scope = await adoptParkedRun(run, options);
    if (scope !== undefined) {
      adopted.set(run.id, scope);
    }
  }
  return adopted;
}

export async function adoptParkedRun(
  run: RunRecord,
  { askable, print, registered, runs, settled }: ParkedRunsOptions
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
      refused = `it is ${stored === null ? "gone" : stored.status} now, not parked`;
      return false;
    }
    sawExecution = execution !== undefined;
    if (execution && SETTLED_EXECUTION_STATUSES.has(execution.status)) {
      refused = "its execution run has settled";
      return false;
    }
    return true;
  });
  if (!claimed) {
    return passed(refused ?? "another live engine owns it");
  }
  if (!sawExecution && (await settled(run.id))) {
    await runs.release(run.id);
    return passed("its execution run has settled");
  }
  const recorded = await runs.recorded(run.id);
  return {
    ledger: recorded.ledger,
    session: { id: recorded.session ?? crypto.randomUUID() },
    ...(recorded.literals === undefined ? {} : { literals: recorded.literals }),
  };
}

async function parked(
  store: Pick<OrchestratorStore, "listRuns">
): Promise<RunRecord[]> {
  const runs: RunRecord[] = [];
  let cursor: number | undefined;
  do {
    const page = await store.listRuns({
      limit: 200,
      order: "oldest",
      status: "suspended",
      ...(cursor === undefined ? {} : { cursor }),
    });
    runs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return runs;
}

export async function workflowStatuses(
  store: Pick<OrchestratorStore, "getRun">,
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
    const run = await store.getRun(execution.id);
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
  readonly print: (line: string) => void;
  readonly runs: RunStore;
  readonly store: Pick<ExecutionCoordinator, "abandonRun" | "listRuns">;
}

export async function closeAbandonedRuns(
  options: AbandonedRunsOptions
): Promise<readonly string[]> {
  const closed: string[] = [];
  if (!options.runs.durable) {
    return closed;
  }
  for (const run of await unsettled(options.store)) {
    const read: { settled?: ExecutionRun } = {};
    const claimed = await options.runs.claim(run.id, (stored, execution) => {
      const open = stored?.status === "queued" || stored?.status === "running";
      if (
        open &&
        execution !== null &&
        execution !== undefined &&
        SETTLED_EXECUTION_STATUSES.has(execution.status)
      ) {
        read.settled = execution;
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
      await options.store.abandonRun(run.id, why);
      options.print(`[run] ${run.step} ${run.id} closed out: ${why.message}`);
      closed.push(run.id);
    } finally {
      await options.runs.release(run.id);
    }
  }
  return closed;
}

async function unsettled(
  store: Pick<OrchestratorStore, "listRuns">
): Promise<RunRecord[]> {
  const runs: RunRecord[] = [];
  let cursor: number | undefined;
  do {
    const page = await store.listRuns({
      limit: 200,
      order: "oldest",
      status: ["queued", "running"],
      ...(cursor === undefined ? {} : { cursor }),
    });
    runs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return runs;
}
