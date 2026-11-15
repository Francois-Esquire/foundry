import type { Artifacts } from "@foundry/artifacts";
import { stopOrphans } from "@foundry/lib/orphans";
import type { ExecutionCoordinator } from "@foundry/workflows";

import type { ExecutionRun } from "./execution-record";
import { SETTLED_EXECUTION_STATUSES } from "./execution-statuses";
import { closeAbandonedRuns } from "./run-recovery";
import type { RunStore } from "./run-store";
import type { HarnessActivities } from "./sandbox/activities";

/**
 * What a starting engine puts right after the Marbles process or an
 * engine died, in one place and one order. Each part's rule is its own
 * module's; this only orders the calls:
 *
 * 1. The children a gone process started and left running are stopped
 *    (`stopOrphans`, from the recovery records under `spawned`), first,
 *    so none of them changes what the later parts put right.
 * 2. Runs a gone process left `queued` or `running` are closed out, once
 *    the launcher has settled their Execution Runs (`closeAbandonedRuns`).
 *    Parked Runs stay parked, for whoever can answer them, and queued
 *    Execution Runs stay queued, as the launcher left them.
 * 3. Harness activities left running in a run that has ended are closed
 *    out (`HarnessActivities.closeOut`); sessions are left as they are.
 * 4. Artifact files no committed record names, and bytes staged by a
 *    process that is gone, are removed (`Artifacts.recover`).
 *
 * Every part acts only on what a process that is gone left, so it is safe
 * beside live engines over the same database, safe to run twice, and safe
 * to stop at any point: what a part did not get to is still there for the
 * next start. A part that fails is reported and the next one runs; the
 * engine starts either way.
 */
export interface CrashRecoveryOptions {
  readonly activities: HarnessActivities;
  readonly artifacts: Pick<Artifacts, "recover">;
  /** The Execution Runs this engine holds, as the launcher left them. */
  readonly executions: () => readonly ExecutionRun[];
  readonly print: (line: string) => void;
  readonly runs: RunStore;
  /**
   * Where the processes this engine's process belongs to record what they
   * start (`MARBLES_SPAWN_RECOVERY`); no child is stopped without one.
   */
  readonly spawned?: string;
}

export class CrashRecovery {
  readonly #options: CrashRecoveryOptions;

  constructor(options: CrashRecoveryOptions) {
    this.#options = options;
  }

  /** Put right what a gone process left, over the engine's workflow records `store`. */
  async recover(
    store: Pick<ExecutionCoordinator, "abandonRun" | "listRuns">
  ): Promise<void> {
    const { activities, artifacts, print, runs, spawned } = this.#options;
    if (spawned !== undefined) {
      await this.#part("processes", async () => {
        const { problems, stopped } = await stopOrphans(spawned);
        if (stopped.length > 0) {
          print(
            `[recovery] stopped ${String(stopped.length)} process(es) a gone engine left running`
          );
        }
        for (const problem of problems) {
          print(`[recovery] ${problem}`);
        }
      });
    }
    await this.#part("runs", () => closeAbandonedRuns({ print, runs, store }));
    await this.#part("activities", async () => {
      const closed = await activities.closeOut(this.#ended());
      if (closed > 0) {
        print(`[recovery] closed out ${String(closed)} harness activity(ies)`);
      }
    });
    await this.#part("artifacts", () => artifacts.recover());
  }

  /** Whether a run has ended: its Execution Run settled, or none is kept. */
  #ended(): (runId: string) => boolean {
    const runs = new Map(
      this.#options.executions().map((run) => [run.id, run])
    );
    return (runId) => {
      const run = runs.get(runId);
      return run === undefined || SETTLED_EXECUTION_STATUSES.has(run.status);
    };
  }

  async #part(name: string, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.#options.print(`[recovery] ${name} not recovered: ${String(error)}`);
    }
  }
}
