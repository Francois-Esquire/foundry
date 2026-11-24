import { basename } from "node:path";
import type { Run, RunId } from "@foundry/queue";
import { makeSqliteQueueStore } from "@foundry/queue/store/sqlite";
import { Tasks } from "@foundry/tasks";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseRunStore, unheldSuspendedRuns } from "~/database/runs";
import { marblesWorkflowRuns } from "~/database/tables";
import { readRun, runStoreEffect } from "~/lib/workflow-runs";
import { putRun } from "./helpers/queue-runs";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

const PAST_THE_LIMIT = 33_000;

let machine: TestMachine;

beforeAll(async () => {
  machine = await testMachine();
});

afterAll(() => {
  machine.close();
});

function strangers(count: number): RunId[] {
  return Array.from(
    { length: count },
    (_, index): RunId => `rn-none-${String(index)}`
  );
}

describe("lists past what one statement binds", () => {
  it("a Run commit deleting that many Runs drops each one's row in the same commit", async () => {
    const scope = basename(machine.workspace());
    const { database } = machine.database;
    const runs = new DatabaseRunStore({ database, scope });
    const store = await runs.open(() => undefined);
    const run = { id: "rn-listed" } as const;
    await putRun(store, run.id, undefined, { step: "s" });
    const row = () =>
      database
        .select({ runId: marblesWorkflowRuns.runId })
        .from(marblesWorkflowRuns)
        .where(
          and(
            eq(marblesWorkflowRuns.scope, scope),
            eq(marblesWorkflowRuns.runId, run.id)
          )
        );
    expect(await row()).toHaveLength(1);

    await runStoreEffect(
      store.commit({
        deleteRuns: [...strangers(PAST_THE_LIMIT), run.id],
      })
    );

    expect(await readRun(store, run.id)).toBeNull();
    expect(await row()).toEqual([]);
    await runs.close();
  }, 120_000);

  it("the suspended Runs no engine holds are read, however many a workspace has", async () => {
    const scope = basename(machine.workspace());
    const { database } = machine.database;
    const store = makeSqliteQueueStore({ database, scope });
    const suspended: Run[] = Array.from(
      { length: PAST_THE_LIMIT },
      (_, index) => ({
        attempt: 1,
        id: `rn-suspended-${String(index)}`,
        jobId: "jb-suspended",
        pool: "marbles",
        revision: 1,
        state: {
          kind: "suspended",
          suspendedAt: 0,
          suspensionId: "su-suspended",
        },
      })
    );
    await runStoreEffect(store.commit({ runs: suspended }));

    const unheld = await unheldSuspendedRuns(database, scope);
    expect(unheld).toHaveLength(PAST_THE_LIMIT);
    expect(new Set(unheld)).toEqual(new Set(suspended.map((run) => run.id)));
  }, 120_000);

  it("an observer's read names that many types and finds the facts of one of them", async () => {
    const state = machine.workspace();
    const records = machine.records(state);
    await new Tasks({ store: records.taskStore }).create({ title: "Typed" });
    const types = [
      ...strangers(PAST_THE_LIMIT).map((id) => `type.${id}`),
      "tasks.changed",
    ];

    const read = await records.log.read({ after: 0, source: "tasks", types });

    expect(read.map((change) => change.fact.type)).toEqual(["tasks.changed"]);
    await records.close();
  });
});
