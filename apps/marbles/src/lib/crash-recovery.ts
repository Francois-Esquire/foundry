import type { Artifacts } from "@foundry/artifacts";
import { stopOrphans } from "@foundry/lib/orphans";
import { removeByHand } from "@foundry/sandbox/container/constants";
import type { Containers } from "@foundry/sandbox/container/containers";
import type { ContainerStore } from "@foundry/sandbox/store";
import type { ExecutionCoordinator } from "@foundry/workflows";
import { z } from "zod";

import type { ExecutionRun } from "./execution-record";
import { SETTLED_EXECUTION_STATUSES } from "./execution-statuses";
import { closeAbandonedRuns } from "./run-recovery";
import type { RunStore } from "./run-store";
import type { HarnessActivities } from "./sandbox/activities";
import { holderState, leftBehind } from "./sandbox/holders";

/** The steps of a recovery, in the order they run. */
const RECOVERY_STEPS = [
  "processes",
  "containers",
  "runs",
  "activities",
  "artifacts",
] as const;
export type RecoveryStepName = (typeof RECOVERY_STEPS)[number];

/**
 * How one step of a start's recovery went: `done`, with what it did;
 * `skipped`, when this engine keeps nothing it would act on; `failed`,
 * with why, the next step having run anyway.
 */
interface RecoveryStep {
  readonly detail: string;
  readonly outcome: "done" | "failed" | "skipped";
  readonly step: RecoveryStepName;
}

/** What a start's recovery did, step by step, and when it ran. */
export interface RecoveryReport {
  /** An ISO time. */
  readonly at: string;
  readonly steps: readonly RecoveryStep[];
}

/** A recovery report as read back: anything else is not one. */
export const recoveryReportSchema = z.object({
  at: z.string(),
  steps: z.array(
    z.object({
      detail: z.string(),
      outcome: z.enum(["done", "failed", "skipped"]),
      step: z.enum(RECOVERY_STEPS),
    })
  ),
});

/**
 * Where a workspace's last recovery report is kept, for `marbles status`
 * (`database/recoveries.ts`); without one, only the engine holds it.
 */
export interface RecoveryLog {
  /** Keep `report` as the workspace's last, in place of the one before. */
  record(report: RecoveryReport): Promise<void>;
}

export interface CrashRecoveryOptions {
  readonly activities: HarnessActivities;
  readonly artifacts: Pick<Artifacts, "recover">;
  /**
   * The container rows kept, read without the runtime, each naming its
   * holder (`lib/sandbox/holders.ts`); without them no container is
   * taken back.
   */
  readonly containerRows?: Pick<ContainerStore, "list">;
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
 *    for it only when there is such a row. A row is deleted only once
 *    every VM labelled with its id is gone, so a start that dies after
 *    the delete, before the sweep, leaves no VM that a later start,
 *    finding no row, would miss.
 * 3. Runs a gone process left `queued` or `running` are closed out, once
 *    the launcher has settled their Execution Runs (`closeAbandonedRuns`).
 *    Parked Runs stay parked, for whoever can answer them, and queued
 *    Execution Runs stay queued, as the launcher left them.
 * 4. Harness activities left running in a run that has ended are closed
 *    out (`HarnessActivities.closeOut`); sessions are left as they are.
 * 5. Artifact files no committed record names, and staging left
 *    unchanged for a day, are removed (`Artifacts.recover`).
 *
 * Modules: nothing to recover until Marbles hosts a module system; their
 * recovery (`createModuleRuntimeRecovery`) needs its program supervisor.
 *
 * Every part acts only on what a process that is gone left, decided on
 * the record itself: a child or container row by its holder's pid and
 * start time, a Run by a claim no live engine holds and its settled
 * Execution Run, an activity by its run's settled Execution Run (a run
 * missing from the list this engine loaded was pruned, and pruning takes
 * only settled runs), and artifact files under the package's own
 * exclusion (each store transaction holds SQLite's write lock from its
 * first statement, and staging is judged by its age, never its owner).
 * So it is safe to run twice, and safe to stop at any point: what a part
 * did not get to is still there for the next start. A part that fails is
 * reported and the next one runs; the engine starts either way, and keeps
 * what each step did (`RecoveryReport`) where `marbles status` reads it.
 */
export class CrashRecovery {
  readonly #options: CrashRecoveryOptions;

  constructor(options: CrashRecoveryOptions) {
    this.#options = options;
  }

  /**
   * Put right what a gone process left, over the engine's workflow records
   * `store`: what each step did, and the ids of the Runs it closed out,
   * for the engine to list.
   */
  async recover(
    store: Pick<ExecutionCoordinator, "abandonRun" | "listRuns">
  ): Promise<{
    readonly closed: readonly string[];
    readonly report: RecoveryReport;
  }> {
    const { activities, artifacts, print, runs } = this.#options;
    let closed: readonly string[] = [];
    const steps: Taken[] = [
      await this.#step("processes", () => this.#processes()),
      await this.#step("containers", () => this.#containers()),
      await this.#step("runs", async () => {
        closed = await closeAbandonedRuns({
          execution: (runId) =>
            this.#options.executions().find((run) => run.id === runId),
          print,
          runs,
          store,
        });
        return done(closed.length, "run(s) closed out");
      }),
      await this.#step("activities", async () =>
        done(
          await activities.closeOut(this.#ended()),
          "harness activity(ies) closed out"
        )
      ),
      await this.#step("artifacts", async () => {
        await artifacts.recover();
        return {
          acted: false,
          detail: "unnamed files removed",
          outcome: "done",
        };
      }),
    ];
    for (const { acted, ...step } of steps) {
      if (acted || step.outcome === "failed") {
        print(`[recovery] ${step.step}: ${step.outcome}, ${step.detail}`);
      }
    }
    return {
      closed,
      report: {
        at: new Date().toISOString(),
        steps: steps.map(({ acted: _acted, ...step }) => step),
      },
    };
  }

  async #processes(): Promise<Outcome> {
    const { spawned } = this.#options;
    if (spawned === undefined) {
      return {
        acted: false,
        detail: "no recovery records kept here",
        outcome: "skipped",
      };
    }
    const { problems, stopped } = await stopOrphans(spawned);
    const count = `${String(stopped.length)} process(es) stopped`;
    const acted = stopped.length > 0;
    return problems.length === 0
      ? { acted, detail: count, outcome: "done" }
      : {
          acted,
          detail: `${count}; ${problems.join("; ")}`,
          outcome: "failed",
        };
  }

  async #containers(): Promise<Outcome> {
    const rows = this.#options.containerRows;
    if (rows === undefined) {
      return {
        acted: false,
        detail: "no container holders kept here",
        outcome: "skipped",
      };
    }
    // Judged here, outside any transaction; the registry's claim checks
    // the holder it was judged by still holds each row. With none left
    // behind, no VM is either: a row goes only with all of its VMs.
    const listed = await rows.list();
    const untold = listed
      .filter((row) => holderState(row) === "unknown")
      .map(({ id }) => id);
    const kept =
      untold.length === 0
        ? ""
        : `; ${String(untold.length)} container(s) whose holder cannot be told gone or running kept: ${untold.join(", ")}`;
    if (!listed.some(leftBehind)) {
      return {
        acted: untold.length > 0,
        detail: `0 container(s) removed${kept}`,
        outcome: "done",
      };
    }
    const containers = await this.#options.containers();
    const recovered = await containers.recover(leftBehind);
    const { conflicts, passedOver, removed, swept } = recovered;
    const did = `${String(removed.length)} container(s) removed, ${String(swept.length)} VM(s) swept`;
    const passed =
      passedOver.length === 0
        ? ""
        : `; ${String(passedOver.length)} VM(s) passed over, not provably this engine's: ${passedOver.join(", ")} (one no engine owns is removed by hand with ${removeByHand("<name>")})`;
    if (recovered.kept.length === 0) {
      return {
        acted:
          removed.length + swept.length + passedOver.length + untold.length > 0,
        detail: `${did}${kept}${passed}`,
        outcome: "done",
      };
    }
    const conflicting =
      conflicts.length === 0
        ? ""
        : `; the VM(s) ${conflicts.join(", ")} bear the id or name of one but are not provably its (another container records them, they carry no label of this store, or their name and label disagree), so they were left alone; one no engine owns is removed by hand with ${removeByHand("<name>")}`;
    return {
      acted: true,
      detail: `${did}; ${String(recovered.kept.length)} container(s) whose VM would not go kept, removing, for the next start to retry${conflicting}${kept}${passed}`,
      outcome: "failed",
    };
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

  /** One step, its failure caught: the next step runs either way. */
  async #step(
    step: RecoveryStepName,
    work: () => Promise<Outcome>
  ): Promise<Taken> {
    try {
      return { step, ...(await work()) };
    } catch (error) {
      return { acted: false, detail: String(error), outcome: "failed", step };
    }
  }
}

/** How a step went, and whether it changed anything, which is what gets printed. */
interface Outcome extends Omit<RecoveryStep, "step"> {
  readonly acted: boolean;
}

type Taken = Outcome & Pick<RecoveryStep, "step">;

function done(count: number, what: string): Outcome {
  return {
    acted: count > 0,
    detail: `${String(count)} ${what}`,
    outcome: "done",
  };
}
