import { basename } from "node:path";
import { Tasks } from "@foundry/tasks";
import { ExecutionCoordinator } from "@foundry/workflows";
import type { RunRecord } from "@foundry/workflows/schema";
import { SqliteWorkflowStore } from "@foundry/workflows/store/sqlite";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseRunStore, unheldParkedRuns } from "~/database/runs";
import { marblesWorkflowRuns } from "~/database/tables";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

/**
 * Every list whose length a caller decides, as the Marbles database reads
 * or writes it: past the 32,766 values one SQLite statement can bind, it
 * still goes through, in the statement or transaction it belongs to.
 */

/** More values than one statement can bind. */
const PAST_THE_LIMIT = 33_000;

let machine: TestMachine;

beforeAll(async () => {
  machine = await testMachine();
});

afterAll(() => {
  machine.close();
});

/** `count` ids no record has. */
function strangers(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `rn-none-${String(index)}`
  );
}

describe("lists past what one statement binds", () => {
  it("a Run commit deleting that many Runs drops each one's row in the same commit", async () => {
    const scope = basename(machine.workspace());
    const { database } = machine.database;
    const runs = new DatabaseRunStore({ database, scope });
    const store = await runs.open(() => undefined);
    const run = await new ExecutionCoordinator({ store }).createRun({
      input: null,
      queueId: "q",
      step: "s",
    });
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

    await store.commit({
      deleteRuns: [...strangers(PAST_THE_LIMIT), run.id],
    });

    expect(await store.getRun(run.id)).toBeNull();
    expect(await row()).toEqual([]);
    await runs.close();
  }, 120_000);

  it("the parked Runs no engine holds are read, however many a workspace has", async () => {
    const scope = basename(machine.workspace());
    const { database } = machine.database;
    const store = new SqliteWorkflowStore({ database, scope });
    const template = await new ExecutionCoordinator({ store }).createRun({
      input: null,
      queueId: "q",
      step: "s",
    });
    const parked: RunRecord[] = Array.from(
      { length: PAST_THE_LIMIT },
      (_, index) => ({
        ...template,
        id: `rn-parked-${String(index)}`,
        status: "suspended",
      })
    );
    await store.commit({ putRuns: parked });

    const unheld = await unheldParkedRuns(database, scope);
    expect(unheld).toHaveLength(PAST_THE_LIMIT);
    expect(new Set(unheld)).toEqual(new Set(parked.map((run) => run.id)));
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
