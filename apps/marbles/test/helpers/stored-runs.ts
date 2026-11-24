import type { ProcessIdentity } from "@foundry/lib/process-identity";
import { makeSqliteQueueStore } from "@foundry/queue/store/sqlite";
import { and, eq } from "drizzle-orm";
import { openDatabase, readDatabase } from "~/database/open";
import { readResourceView } from "~/database/resources";
import { DatabaseRunStore } from "~/database/runs";
import { marblesScheduleTicks, marblesWorkflowRuns } from "~/database/tables";
import { stateDatabase } from "~/layout";
import type { StoredScope } from "~/lib/run-store";
import type { ScheduleHistory } from "~/lib/trigger-store";
import { isRunId, readRun, runStoreEffect } from "~/lib/workflow-runs";
import { putRun } from "./queue-runs";

export interface StoredRunState {
  readonly owner: number | null;
  readonly recorded: StoredScope;
  readonly status: string;
  readonly suspensions: readonly string[];
}

export async function storedRun(
  state: string,
  runId: string,
  scope = "test"
): Promise<StoredRunState | undefined> {
  const read = await readDatabase(
    stateDatabase(state),
    async (database): Promise<StoredRunState | undefined> => {
      const workflows = makeSqliteQueueStore({ database, scope });
      const run = await readRun(workflows, runId);
      if (run === null || !isRunId(runId)) {
        return undefined;
      }
      const suspensions = await runStoreEffect(
        workflows.listSuspensions({ runId })
      );
      const [owned] = await database
        .select({ owner: marblesWorkflowRuns.ownerPid })
        .from(marblesWorkflowRuns)
        .where(
          and(
            eq(marblesWorkflowRuns.scope, scope),
            eq(marblesWorkflowRuns.runId, runId)
          )
        );
      return {
        owner: owned?.owner ?? null,
        recorded: await new DatabaseRunStore({ database, scope }).recorded(
          runId
        ),
        status: run.status,
        suspensions: suspensions.map((wait) => wait.state.kind),
      };
    }
  );
  return read ?? undefined;
}

export interface SeededRun {
  readonly createdAt: number;
  readonly id: string;
  readonly owner: number | null;
  readonly status: "complete" | "failed" | "running";
}

export async function seedRuns(
  state: string,
  scope: string,
  runs: readonly SeededRun[]
): Promise<void> {
  const opened = await openDatabase(stateDatabase(state));
  if (opened === undefined) {
    throw new Error("no Marbles database to seed");
  }
  try {
    const { database } = opened;
    const store = makeSqliteQueueStore({ database, scope });
    for (const run of runs) {
      await putRun(store, run.id, "running", {
        at: run.createdAt,
        step: "guides",
      });
      if (run.status !== "running") {
        await putRun(store, run.id, run.status, { at: run.createdAt });
      }
      await database.insert(marblesWorkflowRuns).values({
        ledger: {},
        literals: {},
        ownerId: run.owner === null ? null : "seeded",
        ownerPid: run.owner,
        runId: run.id,
        scope,
      });
    }
  } finally {
    opened.close();
  }
}

export interface SeededTick {
  readonly key: string;
  readonly last?: ScheduleHistory;
  readonly owner: number | null;
}

export async function seedTicks(
  state: string,
  scope: string,
  ticks: readonly SeededTick[]
): Promise<void> {
  const opened = await openDatabase(stateDatabase(state));
  if (opened === undefined) {
    throw new Error("no Marbles database to seed");
  }
  try {
    for (const { key, last, owner } of ticks) {
      await opened.database.insert(marblesScheduleTicks).values({
        key,
        ...(last ?? {}),
        ownerId: owner === null ? null : "seeded",
        ownerPid: owner,
        scope,
      });
    }
  } finally {
    opened.close();
  }
}

export interface ListedRun {
  readonly createdAt: number;
  readonly id: string;
  readonly owner: ProcessIdentity | null;
  readonly status: string;
  readonly step: string;
}

export async function readStoredRuns(
  state: string,
  scope: string
): Promise<readonly ListedRun[]> {
  const runs = await readResourceView(state, { workspace: scope }, (view) =>
    view.runs()
  );
  return (runs ?? []).map(({ value }) => ({
    createdAt: value.record.timestamps.createdAt,
    id: value.record.id,
    owner: value.owner,
    status: value.record.status,
    step: value.record.step,
  }));
}
