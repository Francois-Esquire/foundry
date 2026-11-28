import type { ArtifactSubstrate } from "@foundry/artifacts";
import type { Containers } from "@foundry/sandbox";
import { defaultRemovalHint } from "@foundry/sandbox";
import type { ContainerRow, ContainerStore } from "@foundry/sandbox/store";
import type {
  RecoveryReport,
  RecoveryStep,
  RecoveryStepName,
} from "./recovery-report";

export type { RecoveryLog, RecoveryReport } from "./recovery-report";

import type { OwnerLiveness } from "~/lib/owner-liveness";

import type { ExecutionRun } from "./execution-record";
import { SETTLED_EXECUTION_STATUSES } from "./execution-statuses";
import type { HarnessActivities } from "./sandbox/activities";
import { holderState, leftBehind } from "./sandbox/holders";

export interface CrashRecoveryOptions {
  readonly activities: HarnessActivities;
  readonly artifacts: Pick<ArtifactSubstrate, "recover">;
  readonly containerRows?: Pick<ContainerStore, "list">;
  readonly containers: () => Promise<Pick<Containers, "recover">>;
  readonly executions: () => readonly ExecutionRun[];
  readonly liveness?: OwnerLiveness;
  readonly print: (line: string) => void;
  readonly spawned?: string;
  readonly stopOrphans?: (spawned: string) => Promise<{
    readonly problems: readonly string[];
    readonly stopped: readonly unknown[];
  }>;
}

export class CrashRecovery {
  readonly #options: CrashRecoveryOptions;

  constructor(options: CrashRecoveryOptions) {
    this.#options = options;
  }

  async recover(runs: () => Promise<readonly string[]>): Promise<{
    readonly closed: readonly string[];
    readonly report: RecoveryReport;
  }> {
    const { activities, artifacts, print } = this.#options;
    let closed: readonly string[] = [];
    const steps: Taken[] = [
      await this.#step("processes", () => this.#processes()),
      await this.#step("containers", () => this.#containers()),
      await this.#step("runs", async () => {
        closed = await runs();
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
    const { spawned, stopOrphans } = this.#options;
    if (spawned === undefined) {
      return {
        acted: false,
        detail: "no recovery records kept here",
        outcome: "skipped",
      };
    }
    if (stopOrphans === undefined) {
      return {
        acted: false,
        detail: "no orphan process handler configured",
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
    const { liveness } = this.#options;
    const isLeftBehind = (row: ContainerRow) => leftBehind(row, liveness);
    const listed = await rows.list();
    const untold = listed
      .filter((row) => holderState(row, liveness) === "unknown")
      .map(({ id }) => id);
    const kept =
      untold.length === 0
        ? ""
        : `; ${String(untold.length)} container(s) whose holder cannot be told gone or running kept: ${untold.join(", ")}`;
    if (!listed.some(isLeftBehind)) {
      return {
        acted: untold.length > 0,
        detail: `0 container(s) removed${kept}`,
        outcome: "done",
      };
    }
    const containers = await this.#options.containers();
    const recovered = await containers.recover(isLeftBehind);
    const { conflicts, passedOver, removed, swept } = recovered;
    const did = `${String(removed.length)} container(s) removed, ${String(swept.length)} VM(s) swept`;
    const passed =
      passedOver.length === 0
        ? ""
        : `; ${String(passedOver.length)} VM(s) passed over, not provably this engine's: ${passedOver.join(", ")} (one no engine owns: ${defaultRemovalHint("<name>")})`;
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
        : `; the VM(s) ${conflicts.join(", ")} bear the id or name of one but are not provably its (another container records them, they carry no label of this store, or their name and label disagree), so they were left alone; one no engine owns: ${defaultRemovalHint("<name>")}`;
    return {
      acted: true,
      detail: `${did}; ${String(recovered.kept.length)} container(s) whose VM would not go kept, removing, for the next start to retry${conflicting}${kept}${passed}`,
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
