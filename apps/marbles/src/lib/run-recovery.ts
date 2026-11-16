import type { OrchestratorStore } from "@foundry/workflows";
import type { RunRecord } from "@foundry/workflows/schema";

import type { ExecutionRun } from "~/lib/execution-record";
import { SETTLED_EXECUTION_STATUSES } from "~/lib/execution-statuses";
import type { RecordedScope } from "~/lib/run-scope";
import type { RunStore } from "~/lib/run-store";

/**
 * Which workflow Runs a starting engine takes on from its run store. The
 * rule is here and nowhere else; the engine hands the Orchestrator only
 * what this adopts (its `recovers` option), and the Orchestrator leaves
 * every other Run as it is stored.
 *
 * - A parked Run (`suspended`) is adopted when the engine can answer what
 *   it waits for (`askable`), its definition is registered, and the engine
 *   wins the claim on it, which no live engine holds, while the Run is
 *   still stored suspended and its Execution Run has not settled (one
 *   cancelled after its process exited stays cancelled): both are read in
 *   the claim's own atomic step, from a run store that keeps Execution
 *   Runs beside its Runs; from one that keeps none, or holds none for the
 *   Run (the host keeps Execution Runs elsewhere), the Execution Run is
 *   read once the claim is held. It is rebuilt from what its scope
 *   recorded.
 * - A Run left `queued` or `running` is never taken on at start: its
 *   process exited mid-flight, and it is not re-executed here; its
 *   Execution Run is settled by the launcher (`Launcher.recover`), and
 *   closing out the Run itself is crash recovery's.
 * - A queued Execution Run is not a Run yet: it stays queued for the
 *   launcher, which lets it in again when the host asks (`recoverQueued`).
 * - Any Run a live engine owns is left alone.
 */

export interface ParkedRunsOptions {
  /** Whether someone can answer `ask` in this process. */
  readonly askable: boolean;
  /** Told why each parked Run passed over stays parked. */
  readonly print: (line: string) => void;
  /** Whether a definition of this name is registered here. */
  readonly registered: (name: string) => boolean;
  readonly runs: RunStore;
  /**
   * Whether the Run's Execution Run is settled, read afresh: asked once the
   * claim is held, when the run store keeps no Execution Runs, or none for
   * this Run, to read in the claim itself.
   */
  readonly settled: (runId: string) => Promise<boolean>;
  /** The workflow records over `runs`. */
  readonly store: Pick<OrchestratorStore, "listRuns">;
}

/** The parked Runs this engine now owns, each with what its scope recorded. */
export async function adoptParkedRuns(
  options: ParkedRunsOptions
): Promise<ReadonlyMap<string, RecordedScope>> {
  const adopted = new Map<string, RecordedScope>();
  if (!options.runs.durable) {
    return adopted;
  }
  for (const run of await parked(options.store)) {
    const scope = await adopt(run, options);
    if (scope !== undefined) {
      adopted.set(run.id, scope);
    }
  }
  return adopted;
}

/**
 * Claim one parked Run and read what it recorded, or `undefined`, owning
 * nothing, when it is not this engine's to take.
 */
async function adopt(
  run: RunRecord,
  { askable, print, registered, runs, settled }: ParkedRunsOptions
): Promise<RecordedScope | undefined> {
  const passed = (why: string): undefined => {
    print(`[run] ${run.step} ${run.id} not adopted: ${why}`);
  };
  if (!(askable && registered(run.step))) {
    return passed("nothing here can resume it");
  }
  // The scan that found it is already old: whether it is still parked, and
  // its Execution Run still open, is decided again in the claim's own
  // atomic step. A canceller takes the same claim before it settles one.
  let refused: string | undefined;
  let sawExecution = false;
  const claimed = await runs.claim(run.id, (stored, execution) => {
    if (stored?.status !== "suspended") {
      refused = `it is ${stored === null ? "gone" : stored.status} now, not parked`;
      return false;
    }
    // `null` is no Execution Run beside the Run, which says nothing of one
    // the host keeps in another store: that is read once the claim is held.
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
  // Asked again with the claim held, only when the claim did not read the
  // Execution Run: one read in the claim's own step is current, since a
  // canceller settles it only while it holds the claim, in a write that
  // cannot land inside this one.
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

/** Every parked Run in the store, oldest first. */
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

/**
 * The status each unsettled workflow Execution Run's Run is stored with,
 * for the launcher to reconcile a record with a Run committed just before
 * its process exited. A Run the store does not hold is left out.
 */
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
