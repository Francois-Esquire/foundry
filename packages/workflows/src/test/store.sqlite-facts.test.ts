import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";
import type { RunFact } from "../index";
import { ExecutionCoordinator } from "../index";
import type { WorkflowTransaction } from "../store/sqlite";
import { SqliteWorkflowStore } from "../store/sqlite";
import { libsqlDatabases } from "./helpers/sqlite";

const memory = libsqlDatabases("memory");

/** A host's record of facts, written on the commit's own transaction. */
const recorded = sqliteTable("recorded_facts", {
  fact: text("fact", { mode: "json" }).notNull(),
});

/**
 * A SQLite store whose `onCommit` writes each fact of a write as a row on
 * the transaction it is handed, as a host's outbox would, and counts calls.
 */
async function hosted() {
  const database = await memory.open();
  await database.run(sql`CREATE TABLE "recorded_facts" ("fact" text NOT NULL)`);
  const calls: (readonly RunFact[])[] = [];
  const store = new SqliteWorkflowStore({
    database,
    onCommit: async (transaction: WorkflowTransaction, write) => {
      calls.push(write.facts ?? []);
      for (const item of write.facts ?? []) {
        await transaction.insert(recorded).values({ fact: item });
      }
    },
    scope: "host",
  });
  const rows = async (): Promise<RunFact[]> =>
    (await database.select().from(recorded)).map((row) => row.fact as RunFact);
  return {
    calls,
    coordinator: new ExecutionCoordinator({ store }),
    rows,
    store,
  };
}

const RUN = { input: null, queueId: "q", step: "s" } as const;

describe("SqliteWorkflowStore change facts", () => {
  test("a Run's facts reach onCommit inside the commit that makes them, once each", async () => {
    const { calls, coordinator, rows } = await hosted();
    const run = await coordinator.createRun(RUN);
    await coordinator.updateRun(run.id, { status: "running" });
    await coordinator.updateRun(run.id, { output: { partial: true } });
    await coordinator.updateRun(run.id, { status: "complete" });

    const facts = await rows();
    expect(facts.map((fact) => fact.type)).toStrictEqual([
      "run.queued",
      "run.started",
      "run.completed",
    ]);
    // One call per commit; the patch that kept the status brought none.
    expect(calls.map((made) => made.length)).toStrictEqual([1, 1, 0, 1]);
    expect(calls.flat()).toStrictEqual(facts);
  });

  test("hands a write's facts on in order, as they stood when commit was called", async () => {
    const { calls, rows, store } = await hosted();
    const run = await new ExecutionCoordinator().createRun(RUN);
    const facts: RunFact[] = [
      runFact("rf-1", "run.queued", run.id),
      runFact("rf-2", "run.started", run.id),
    ];
    const expected = structuredClone(facts);

    const committing = store.commit({ facts, putRuns: [run] });
    facts.reverse();
    Object.assign(facts[0] ?? {}, { type: "run.failed" });
    await committing;

    expect(calls).toStrictEqual([expected]);
    expect(await rows()).toStrictEqual(expected);
    expect(await store.getRun(run.id)).toStrictEqual(run);
  });

  test("facts of a commit that fails never land, whether refused or rolled back", async () => {
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

    expect((await rows()).map((fact) => fact.type)).toStrictEqual([
      "run.queued",
    ]);
    // The rolled-back commit did reach onCommit; its rows went with it.
    expect(calls.map((facts) => facts.map((item) => item.type))).toStrictEqual([
      ["run.queued"],
      ["run.started"],
    ]);
    expect((await coordinator.getRun(run.id))?.status).toBe("queued");
  });
});

function runFact(id: string, type: RunFact["type"], runId: string): RunFact {
  return { at: "2026-11-15T00:00:00.000Z", id, queueId: "q", runId, type };
}
