import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";
import type { RunEvent } from "../index";
import { ExecutionCoordinator } from "../index";
import type { WorkflowTransaction } from "../store/sqlite";
import { SqliteWorkflowStore } from "../store/sqlite";
import { libsqlDatabases } from "./helpers/sqlite";

const memory = libsqlDatabases("memory");

const recorded = sqliteTable("recorded_events", {
  event: text("event", { mode: "json" }).notNull(),
});

async function hosted() {
  const database = await memory.open();
  await database.run(
    sql`CREATE TABLE "recorded_events" ("event" text NOT NULL)`
  );
  const calls: (readonly RunEvent[])[] = [];
  const store = new SqliteWorkflowStore({
    database,
    onCommit: async (transaction: WorkflowTransaction, write) => {
      calls.push(write.events ?? []);
      for (const item of write.events ?? []) {
        await transaction.insert(recorded).values({ event: item });
      }
    },
    scope: "host",
  });
  const rows = async (): Promise<RunEvent[]> =>
    (await database.select().from(recorded)).map(
      (row) => row.event as RunEvent
    );
  return {
    calls,
    coordinator: new ExecutionCoordinator({ store }),
    rows,
    store,
  };
}

const RUN = { input: null, queueId: "q", step: "s" } as const;

describe("SqliteWorkflowStore change events", () => {
  test("a Run's events reach onCommit inside the commit that makes them, once each", async () => {
    const { calls, coordinator, rows } = await hosted();
    const run = await coordinator.createRun(RUN);
    await coordinator.updateRun(run.id, { status: "running" });
    await coordinator.updateRun(run.id, {
      snapshot: { cursor: null, input: null, name: "s", steps: [] },
    });
    await coordinator.updateRun(run.id, { tags: { customer: "a" } });
    await coordinator.updateRun(run.id, { status: "complete" });

    const events = await rows();
    expect(events.map((event) => event.type)).toStrictEqual([
      "run.queued",
      "run.started",
      "run.updated",
      "run.completed",
    ]);
    expect(calls.map((made) => made.length)).toStrictEqual([1, 1, 0, 1, 1]);
    expect(calls.flat()).toStrictEqual(events);
  });

  test("events of a commit that fails never land, whether refused or rolled back", async () => {
    const { calls, coordinator, rows } = await hosted();
    const run = await coordinator.createRun(RUN);

    await expect(
      coordinator.createRun({ ...RUN, step: "s\u0000" })
    ).rejects.toThrow(RangeError);
    const { transaction } = coordinator;
    if (transaction === undefined) {
      throw new Error("the SQLite store offers transactions");
    }
    await expect(
      transaction(async (inside) => {
        await inside.updateRun(run.id, { status: "running" });
        throw new Error("host gave up");
      })
    ).rejects.toThrow("host gave up");

    expect((await rows()).map((event) => event.type)).toStrictEqual([
      "run.queued",
    ]);
    expect(
      calls.map((events) => events.map((item) => item.type))
    ).toStrictEqual([["run.queued"], ["run.started"]]);
    expect((await coordinator.getRun(run.id))?.status).toBe("queued");
  });
});
