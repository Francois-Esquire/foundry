import { ExecutionCoordinator } from "@foundry/workflows";
import { SqliteWorkflowStore } from "@foundry/workflows/store/sqlite";
import { and, eq } from "drizzle-orm";
import { openDatabase, readDatabase } from "~/database/open";
import { DatabaseRunStore } from "~/database/runs";
import { marblesScheduleTicks, marblesWorkflowRuns } from "~/database/tables";
import { stateDatabase } from "~/layout";
import type { StoredScope } from "~/lib/run-store";
import type { ScheduleHistory } from "~/lib/trigger-store";

/** What the Marbles database keeps of one Run, as a later process would find it. */
export interface StoredRunState {
  /** The process of the engine that owns it; `null` when none does. */
  readonly owner: number | null;
  /** What its scope recorded beside it. */
  readonly recorded: StoredScope;
  readonly status: string;
  /** The status of each Suspension it filed, in order. */
  readonly suspensions: readonly string[];
}

/**
 * The Run `runId` of the workspace `scope` (a test engine's, `test`, by
 * default) as the Marbles database at the state root `state` holds it,
 * read only; `undefined` when it holds none.
 */
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

/** A Run as an earlier process left it, for `seedRuns`. */
export interface SeededRun {
  readonly createdAt: number;
  readonly id: string;
  /** The process of the engine that owned it; `null` for none. */
  readonly owner: number | null;
  readonly status: "complete" | "failed" | "running";
}

/**
 * Put `runs` in the Marbles database at the state root `state`, under the
 * workspace `scope`, each with its owner beside it, as engines that have
 * since stopped would have left them. The database must be there.
 */
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

/** A trigger's tick row as an engine left it, for `seedTicks`. */
export interface SeededTick {
  readonly key: string;
  /** How its last tick went; absent before its first. */
  readonly last?: ScheduleHistory;
  /** The process whose tick of it is under way; `null` for none. */
  readonly owner: number | null;
}

/**
 * Put `ticks` in the Marbles database at the state root `state`, under
 * the workspace `scope`, as engines would have left them. The database
 * must be there.
 */
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
