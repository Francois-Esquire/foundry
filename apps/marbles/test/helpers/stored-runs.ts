import {
  nodeStartedAt,
  type ProcessIdentity,
} from "@foundry/lib/node/process-identity";
import { makeSqliteQueueStore } from "@foundry/queue/store/sqlite";
import { type Occurrence, occurrenceId } from "@foundry/scheduling";
import { makeSqliteScheduleStore } from "@foundry/scheduling/store/sqlite";
import { openDatabase, readDatabase, readResourceView } from "~/database/open";
import { DatabaseRunStore } from "~/database/runs";
import { stateDatabase } from "~/layout";
import { ownerOfRun } from "~/lib/executions/record";
import { isRunId, readRun, runStoreEffect } from "~/lib/runs/records";
import type { StoredScope } from "~/lib/runs/store";
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
      const stored = await runStoreEffect(workflows.getRun(runId));
      const owner = stored && ownerOfRun(stored);
      return {
        owner: owner?.pid ?? null,
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
        ...(run.owner === null
          ? {}
          : {
              owner: {
                pid: run.owner,
                started: nodeStartedAt(run.owner) ?? null,
              },
            }),
        step: "guides",
      });
      if (run.status !== "running") {
        await putRun(store, run.id, run.status, { at: run.createdAt });
      }
    }
  } finally {
    opened.close();
  }
}

export interface SeededSchedule {
  readonly key: string;
  readonly kind?: "schedule" | "monitor";
  readonly label?: string;
  readonly last?: {
    readonly outcome: "complete" | "failed" | "cancelled";
    readonly settledAt: string;
  };
  readonly nextDue?: string;
  readonly owner?: number | null;
}

function occurrenceOf({
  key,
  last,
  owner,
}: SeededSchedule): Occurrence | undefined {
  if (owner !== undefined && owner !== null) {
    return {
      id: occurrenceId(key, 1),
      scheduledFor: 1,
      scheduleId: key,
      state: {
        claimedAt: 1,
        kind: "claimed" as const,
        lease: {
          claimedAt: 1,
          owner: { pid: owner, started: nodeStartedAt(owner) ?? null },
        },
      },
    };
  }
  if (last === undefined) {
    return;
  }
  const settledAt = Date.parse(last.settledAt);
  return {
    id: occurrenceId(key, settledAt),
    scheduledFor: settledAt,
    scheduleId: key,
    state: {
      jobId: "rn-seeded",
      kind: "settled" as const,
      outcome: last.outcome,
      settledAt,
    },
  };
}

export async function seedSchedules(
  state: string,
  scope: string,
  schedules: readonly SeededSchedule[]
): Promise<void> {
  const opened = await openDatabase(stateDatabase(state));
  if (opened === undefined) {
    throw new Error("no Marbles database to seed");
  }
  try {
    const store = makeSqliteScheduleStore({ database: opened.database, scope });
    for (const seeded of schedules) {
      const { key, kind = "schedule", label = key, nextDue } = seeded;
      const occurrence = occurrenceOf(seeded);
      await runStoreEffect(
        store.commit({
          cursors: [
            {
              nextDueAt: nextDue === undefined ? null : Date.parse(nextDue),
              scheduleId: key,
            },
          ],
          occurrences: occurrence === undefined ? [] : [occurrence],
          schedules: [
            {
              cadence: { afterSettleMs: 60_000, kind: "delay" },
              createdAt: 0,
              id: key,
              misfire: "run-once",
              overlap: "skip",
              state: "active",
              target: {
                handler: { name: key },
                input: { input: null, kind, label },
              },
            },
          ],
        })
      );
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
