import { createTables } from "@foundry/lib/testing/sqlite";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import type { Occurrence, Schedule, ScheduleEvent } from "../domain";
import {
  makeSqliteScheduleStore,
  type ScheduleDatabase,
} from "../store/sqlite";
import { schedulingTables } from "../store/tables";
import { target } from "./helpers/scheduler";

const clients: ReturnType<typeof createClient>[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
});

const openDatabase = async (): Promise<ScheduleDatabase> => {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  const database = drizzle(client);
  await createTables(database, schedulingTables);
  return database;
};

const schedule: Schedule = {
  cadence: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
  createdAt: 0,
  id: "nightly",
  misfire: "run-once",
  overlap: "skip",
  state: "active",
  target,
};

const claimed = (owner: number): Occurrence => ({
  id: "nightly:1000",
  scheduledFor: 1000,
  scheduleId: "nightly",
  state: {
    claimedAt: 1000,
    kind: "claimed",
    lease: { claimedAt: 1000, owner: { pid: owner, started: null } },
  },
});

describe("SqliteScheduleStore", () => {
  test("a reopened store reads what another committed, and onCommit receives the write's events", async () => {
    const database = await openDatabase();
    const committed: ScheduleEvent["type"][] = [];
    const store = makeSqliteScheduleStore({
      database,
      onCommit: async (_transaction, write) => {
        committed.push(...(write.events ?? []).map((event) => event.type));
      },
      scope: "alpha",
    });
    await Effect.runPromise(
      store.commit({
        cursors: [{ nextDueAt: 2000, scheduleId: "nightly" }],
        events: [{ at: 0, id: "ev-1", schedule, type: "schedule.registered" }],
        occurrences: [claimed(1)],
        schedules: [schedule],
      })
    );
    const reopened = makeSqliteScheduleStore({ database, scope: "alpha" });
    const read = await Effect.runPromise(
      Effect.all({
        cursor: reopened.getCursor("nightly"),
        occurrences: reopened.listOccurrences(),
        schedules: reopened.listSchedules,
      })
    );
    expect(read).toEqual({
      cursor: { nextDueAt: 2000, scheduleId: "nightly" },
      occurrences: [claimed(1)],
      schedules: [schedule],
    });
    expect(committed).toEqual(["schedule.registered"]);
  });

  test("two stores racing to claim one occurrence produce exactly one winner", async () => {
    const database = await openDatabase();
    const one = makeSqliteScheduleStore({ database, scope: "alpha" });
    const other = makeSqliteScheduleStore({ database, scope: "alpha" });
    const wins = await Effect.runPromise(
      Effect.all([one.claim(claimed(1)), other.claim(claimed(2))], {
        concurrency: "unbounded",
      })
    );
    const stored = await Effect.runPromise(one.getOccurrence("nightly:1000"));
    expect(wins.filter(Boolean)).toHaveLength(1);
    const winner = wins[0] ? 1 : 2;
    expect(stored?.state).toMatchObject({ lease: { owner: { pid: winner } } });
  });

  test("stores in different scopes on one database never see each other's records", async () => {
    const database = await openDatabase();
    const alpha = makeSqliteScheduleStore({ database, scope: "alpha" });
    const beta = makeSqliteScheduleStore({ database, scope: "beta" });
    await Effect.runPromise(alpha.commit({ schedules: [schedule] }));
    const results = await Effect.runPromise(
      Effect.all([
        alpha.claim(claimed(1)),
        beta.claim(claimed(1)),
        beta.listSchedules,
        beta.getSchedule("nightly"),
      ])
    );
    expect(results).toEqual([true, true, [], undefined]);
  });
});
