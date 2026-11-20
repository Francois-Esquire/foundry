import type { ProcessIdentity } from "@foundry/lib/process-identity";
import { ExecutionCoordinator } from "@foundry/workflows";
import { SqliteWorkflowStore } from "@foundry/workflows/store/sqlite";
import { and, eq } from "drizzle-orm";
import { openDatabase, readDatabase } from "~/database/open";
import { readResourceView } from "~/database/resources";
import { DatabaseRunStore } from "~/database/runs";
import { marblesScheduleTicks, marblesWorkflowRuns } from "~/database/tables";
import { stateDatabase } from "~/layout";
import type { StoredScope } from "~/lib/run-store";
import type { ScheduleHistory } from "~/lib/trigger-store";

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
      const workflows = new SqliteWorkflowStore({ database, scope });
      const run = await workflows.getRun(runId);
      if (run === null) {
        return undefined;
      }
      const suspensions = await workflows.listSuspensions({
        limit: 100,
        runId,
      });
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
        suspensions: suspensions.items.map((suspension) => suspension.status),
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
    const store = new ExecutionCoordinator({
      store: new SqliteWorkflowStore({ database, scope }),
    });
    const queue = await store.ensureQueue({ id: "qu-seeded", name: "marbles" });
    for (const run of runs) {
      await store.createRun({
        id: run.id,
        input: null,
        queueId: queue.id,
        step: "guides",
      });
      await store.updateRun(run.id, {
        status: "running",
        timestamps: { createdAt: run.createdAt },
      });
      if (run.status !== "running") {
        await store.updateRun(run.id, { status: run.status });
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
