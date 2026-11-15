import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";
import type { RunEvent } from "../index";
import { ExecutionCoordinator } from "../index";
import type { WorkflowTransaction } from "../store/sqlite";
import { SqliteWorkflowStore } from "../store/sqlite";
import { libsqlDatabases } from "./helpers/sqlite";

const memory = libsqlDatabases("memory");

/** A host's record of events, written on the commit's own transaction. */
const recorded = sqliteTable("recorded_events", {
  event: text("event", { mode: "json" }).notNull(),
});

/**
 * A SQLite store whose `onCommit` writes each event of a write as a row on
 * the transaction it is handed, as a host's outbox would, and counts calls.
 */
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
    await coordinator.updateRun(run.id, { output: { partial: true } });
    await coordinator.updateRun(run.id, { status: "complete" });

    const events = await rows();
    expect(events.map((event) => event.type)).toStrictEqual([
      "run.queued",
      "run.started",
      "run.completed",
    ]);
    // One call per commit; the patch that kept the status brought none.
    expect(calls.map((made) => made.length)).toStrictEqual([1, 1, 0, 1]);
    expect(calls.flat()).toStrictEqual(events);
  });

  test("hands a write's events on in order, as they stood when commit was called", async () => {
    const { calls, rows, store } = await hosted();
    const run = await new ExecutionCoordinator().createRun(RUN);
    const events: RunEvent[] = [
      runEvent("rf-1", "run.queued", run.id),
      runEvent("rf-2", "run.started", run.id),
    ];
    const expected = structuredClone(events);

    const committing = store.commit({ events, putRuns: [run] });
    events.reverse();
    Object.assign(events[0] ?? {}, { type: "run.failed" });
    await committing;

    expect(calls).toStrictEqual([expected]);
    expect(await rows()).toStrictEqual(expected);
    expect(await store.getRun(run.id)).toStrictEqual(run);
  });

  test("events of a commit that fails never land, whether refused or rolled back", async () => {
    const { calls, coordinator, rows } = await hosted();
    const run = await coordinator.createRun(RUN);

    // Refused before its transaction: text SQLite would not give back.
    await expect(
      coordinator.createRun({ ...RUN, step: "s\u0000" })
    ).rejects.toThrow(RangeError);
    // Committed inside a transaction whose work then throws.
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
    // The rolled-back commit did reach onCommit; its rows went with it.
    expect(
      calls.map((events) => events.map((item) => item.type))
    ).toStrictEqual([["run.queued"], ["run.started"]]);
    expect((await coordinator.getRun(run.id))?.status).toBe("queued");
  });
});

function runEvent(id: string, type: RunEvent["type"], runId: string): RunEvent {
  return { at: "2026-11-15T00:00:00.000Z", id, queueId: "q", runId, type };
}
