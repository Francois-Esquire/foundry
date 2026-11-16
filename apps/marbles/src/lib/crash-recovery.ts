import type { Artifacts } from "@foundry/artifacts";
import { stopOrphans } from "@foundry/lib/orphans";
import type { Containers } from "@foundry/sandbox/container/containers";
import type { ContainerStore } from "@foundry/sandbox/store";
import type { ExecutionCoordinator } from "@foundry/workflows";
import { z } from "zod";

import type { ExecutionRun } from "./execution-record";
import { SETTLED_EXECUTION_STATUSES } from "./execution-statuses";
import { closeAbandonedRuns } from "./run-recovery";
import type { RunStore } from "./run-store";
import type { HarnessActivities } from "./sandbox/activities";
import { leftBehind } from "./sandbox/holders";

const RECOVERY_STEPS = [
  "processes",
  "containers",
  "runs",
  "activities",
  "artifacts",
] as const;
export type RecoveryStepName = (typeof RECOVERY_STEPS)[number];

interface RecoveryStep {
  readonly detail: string;
  readonly outcome: "done" | "failed" | "skipped";
  readonly step: RecoveryStepName;
}

export interface RecoveryReport {
  readonly at: string;
  readonly steps: readonly RecoveryStep[];
}

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

export interface RecoveryLog {
  record(report: RecoveryReport): Promise<void>;
}

export interface CrashRecoveryOptions {
  readonly activities: HarnessActivities;
  readonly artifacts: Pick<Artifacts, "recover">;
  readonly containerRows?: Pick<ContainerStore, "list">;
  readonly containers: () => Promise<Pick<Containers, "recover">>;
  readonly executions: () => readonly ExecutionRun[];
  readonly print: (line: string) => void;
  readonly runs: RunStore;
  readonly spawned?: string;
}

export class CrashRecovery {
  readonly #options: CrashRecoveryOptions;

  constructor(options: CrashRecoveryOptions) {
    this.#options = options;
  }

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
        closed = await closeAbandonedRuns({ print, runs, store });
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
    if (!(await rows.list()).some(leftBehind)) {
      return done(0, "container(s) removed");
    }
    const containers = await this.#options.containers();
    const { kept, removed, swept } = await containers.recover(leftBehind);
    const did = `${String(removed.length)} container(s) removed, ${String(swept.length)} VM(s) swept`;
    return kept.length === 0
      ? {
          acted: removed.length + swept.length > 0,
          detail: did,
          outcome: "done",
        }
      : {
          acted: true,
          detail: `${did}; ${String(kept.length)} container(s) whose VM would not go kept, removing, for the next start to retry`,
          outcome: "failed",
        };
  }

  #ended(): (runId: string) => boolean {
    const runs = new Map(
      this.#options.executions().map((run) => [run.id, run])
    );
    return (runId) => {
      const run = runs.get(runId);
      return run === undefined || SETTLED_EXECUTION_STATUSES.has(run.status);
    };
  }

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
