import type { Artifacts } from "@foundry/artifacts";
import { stopOrphans } from "@foundry/lib/orphans";
import type { Containers } from "@foundry/sandbox/container/containers";
import type { ExecutionCoordinator } from "@foundry/workflows";

import type { ExecutionRun } from "./execution-record";
import { SETTLED_EXECUTION_STATUSES } from "./execution-statuses";
import { closeAbandonedRuns } from "./run-recovery";
import type { RunStore } from "./run-store";
import type { HarnessActivities } from "./sandbox/activities";

/**
 * Which of a workspace's container rows a process that is gone left, by
 * who holds each (`database/containers.ts`).
 */
export interface ContainerOwners {
  /** Whether any row was left so: only then is the container runtime started. */
  anyLeft(): Promise<boolean>;
  /** Whether the row `id` was left so. */
  left(id: string): Promise<boolean>;
}

export interface CrashRecoveryOptions {
  readonly activities: HarnessActivities;
  readonly artifacts: Pick<Artifacts, "recover">;
  /** Who holds the container rows; without it no container is taken back. */
  readonly containerOwners?: ContainerOwners;
  /** The engine's containers, started once, as its sandboxes use them. */
  readonly containers: () => Promise<Pick<Containers, "recover">>;
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

/**
 * What a starting engine puts right after the Marbles process or an
 * engine died, in one place and one order. Each part's rule is its own
 * module's; this only orders the calls:
 *
 * 1. The children a gone process started and left running are stopped
 *    (`stopOrphans`, from the recovery records under `spawned`), first,
 *    so none of them changes what the later parts put right.
 * 2. Container rows a gone process left are removed, with their VMs, and
 *    VMs with no row swept (`Containers.recover`); the runtime is started
 *    for it only when there is such a row.
 * 3. Runs a gone process left `queued` or `running` are closed out, once
 *    the launcher has settled their Execution Runs (`closeAbandonedRuns`).
 *    Parked Runs stay parked, for whoever can answer them, and queued
 *    Execution Runs stay queued, as the launcher left them.
 * 4. Harness activities left running in a run that has ended are closed
 *    out (`HarnessActivities.closeOut`); sessions are left as they are.
 * 5. Artifact files no committed record names, and bytes staged by a
 *    process that is gone, are removed (`Artifacts.recover`).
 *
 * Every part acts only on what a process that is gone left, decided on
 * the record itself: a child or container row by its holder's pid and
 * start time, a Run by a claim no live engine holds and its settled
 * Execution Run, an activity by its run's settled Execution Run (a run
 * missing from the list this engine loaded was pruned, and pruning takes
 * only settled runs), and artifact files under the package's own
 * exclusion (each store transaction holds SQLite's write lock from its
 * first statement, and staged bytes are kept while their owner lives).
 * So it is safe to run twice, and safe to stop at any point: what a part
 * did not get to is still there for the next start. A part that fails is
 * reported and the next one runs; the engine starts either way.
 */
export class CrashRecovery {
  readonly #options: CrashRecoveryOptions;

  constructor(options: CrashRecoveryOptions) {
    this.#options = options;
  }

  /**
   * Put right what a gone process left, over the engine's workflow records
   * `store`; the ids of the Runs it closed out, for the engine to list.
   */
  async recover(
    store: Pick<ExecutionCoordinator, "abandonRun" | "listRuns">
  ): Promise<readonly string[]> {
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
    await this.#part("containers", () => this.#containers());
    let closed: readonly string[] = [];
    await this.#part("runs", async () => {
      closed = await closeAbandonedRuns({ print, runs, store });
    });
    await this.#part("activities", async () => {
      const count = await activities.closeOut(this.#ended());
      if (count > 0) {
        print(`[recovery] closed out ${String(count)} harness activity(ies)`);
      }
    });
    await this.#part("artifacts", () => artifacts.recover());
    return closed;
  }

  async #containers(): Promise<void> {
    const owners = this.#options.containerOwners;
    if (!(owners && (await owners.anyLeft()))) {
      return;
    }
    const containers = await this.#options.containers();
    const { removed, swept } = await containers.recover((row) =>
      owners.left(row.id)
    );
    if (removed.length + swept.length > 0) {
      this.#options.print(
        `[recovery] removed ${String(removed.length)} container(s) and swept ${String(swept.length)} VM(s) a gone engine left`
      );
    }
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
