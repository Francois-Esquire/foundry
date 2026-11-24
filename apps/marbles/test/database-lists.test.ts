import { basename } from "node:path";
import type { RunId } from "@foundry/queue";
import { Tasks } from "@foundry/tasks";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseRunStore } from "~/database/runs";
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
    const store = await runs.open(() => ({
      ledger: {},
      session: { id: "run-session" },
    }));
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
