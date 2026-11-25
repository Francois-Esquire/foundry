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
  test("persists schedules, cursors, and occurrences, and removing a schedule removes all three", async () => {
    const database = await openDatabase();
    const committed: ScheduleEvent["type"][] = [];
    const store = makeSqliteScheduleStore({
      database,
      onCommit: async (_transaction, write) => {
        committed.push(...(write.events ?? []).map((event) => event.type));
      },
      scope: "alpha",
    });
    const dispatched: Occurrence = {
      ...claimed(1),
      state: { dispatchedAt: 1000, jobId: "jb-1", kind: "dispatched" },
    };
    await Effect.runPromise(
      store.commit({
        cursors: [{ nextDueAt: 2000, scheduleId: "nightly" }],
        events: [{ at: 0, id: "ev-1", schedule, type: "schedule.registered" }],
        occurrences: [dispatched],
        schedules: [schedule],
      })
    );
    const reopened = makeSqliteScheduleStore({ database, scope: "alpha" });
    const read = await Effect.runPromise(
      Effect.all({
        cursor: reopened.getCursor("nightly"),
        open: reopened.listOccurrences({
          scheduleId: "nightly",
          state: "dispatched",
        }),
        schedules: reopened.listSchedules,
      })
    );
    await Effect.runPromise(reopened.commit({ removed: ["nightly"] }));
    const removed = await Effect.runPromise(
      Effect.all([
        reopened.getSchedule("nightly"),
        reopened.getCursor("nightly"),
        reopened.listOccurrences(),
      ])
    );
    expect(read).toEqual({
      cursor: { nextDueAt: 2000, scheduleId: "nightly" },
      open: [dispatched],
      schedules: [schedule],
    });
    expect(committed).toEqual(["schedule.registered"]);
    expect(removed).toEqual([undefined, undefined, []]);
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

  test("a claim is taken over only from the occurrence the taker read", async () => {
    const database = await openDatabase();
    const store = makeSqliteScheduleStore({ database, scope: "alpha" });
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.claim(claimed(1));
        const stale = yield* store.claim(claimed(3), claimed(2));
        const taken = yield* store.claim(claimed(2), claimed(1));
        return {
          stale,
          stored: yield* store.getOccurrence("nightly:1000"),
          taken,
        };
      })
    );
    expect(results.stale).toBe(false);
    expect(results.taken).toBe(true);
    expect(results.stored?.state).toMatchObject({
      lease: { owner: { pid: 2 } },
    });
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

  test("a commit retaining occurrences keeps the newest terminal ones and every open one, and reads the latest", async () => {
    const database = await openDatabase();
    const store = makeSqliteScheduleStore({ database, scope: "retain" });
    const at = (scheduledFor: number, state: Occurrence["state"]) => ({
      id: `nightly:${scheduledFor}` as const,
      scheduledFor,
      scheduleId: "nightly",
      state,
    });
    const skipped = (scheduledFor: number) =>
      at(scheduledFor, {
        at: scheduledFor,
        kind: "skipped",
        reason: "overlap",
      });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.commit({
          occurrences: [
            at(1, { dispatchedAt: 1, jobId: "jb-1", kind: "dispatched" }),
            ...[2, 3, 4, 5].map(skipped),
          ],
        });
        yield* store.commit({
          maxOccurrencesPerSchedule: 2,
          occurrences: [skipped(6)],
        });
        return {
          kept: yield* store.listOccurrences({ scheduleId: "nightly" }),
          latest: yield* store.latestOccurrence("nightly"),
        };
      })
    );
    expect(result.kept.map((occurrence) => occurrence.scheduledFor)).toEqual([
      1, 5, 6,
    ]);
    expect(result.latest?.scheduledFor).toBe(6);
  });

  test("a commit expecting a cursor writes nothing when the stored cursor moved, and a claim is released only by its owner", async () => {
    const database = await openDatabase();
    const store = makeSqliteScheduleStore({ database, scope: "guarded" });
    const read = { nextDueAt: 1000, scheduleId: "nightly" };
    const moved = {
      lastSettledAt: 900,
      nextDueAt: 1900,
      scheduleId: "nightly",
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.commit({ cursors: [moved] });
        const conflict = yield* Effect.flip(
          store.commit({
            cursors: [{ nextDueAt: null, scheduleId: "nightly" }],
            expectedCursors: [read],
            occurrences: [claimed(7)],
          })
        );
        yield* store.commit({
          cursors: [{ ...moved, nextDueAt: 2900 }],
          expectedCursors: [moved],
        });
        yield* store.claim(claimed(7));
        const blockedByExclusive = yield* store.claim(
          { ...claimed(8), id: "nightly:2000", scheduledFor: 2000 },
          undefined,
          true
        );
        yield* store.releaseClaim("nightly:1000", { pid: 8, started: null });
        const keptForOwner = yield* store.getOccurrence("nightly:1000");
        yield* store.releaseClaim("nightly:1000", { pid: 7, started: null });
        const guardedSchedule = {
          cadence: { everyMs: 1000, kind: "interval" as const },
          createdAt: 0,
          id: "nightly",
          misfire: "run-once" as const,
          overlap: "skip" as const,
          state: "active" as const,
          target: { handler: { name: "sync" }, input: null },
        };
        yield* store.commit({ schedules: [guardedSchedule] });
        const scheduleConflict = yield* Effect.flip(
          store.commit({
            expectedSchedules: [{ ...guardedSchedule, state: "paused" }],
            schedules: [{ ...guardedSchedule, state: "paused" }],
          })
        );
        return {
          blockedByExclusive,
          conflict: conflict._tag,
          cursor: yield* store.getCursor("nightly"),
          keptForOwner: keptForOwner?.state.kind,
          released: yield* store.getOccurrence("nightly:1000"),
          scheduleConflict: scheduleConflict._tag,
        };
      })
    );
    expect(result).toEqual({
      blockedByExclusive: false,
      conflict: "CursorConflictError",
      cursor: { ...moved, nextDueAt: 2900 },
      keptForOwner: "claimed",
      released: undefined,
      scheduleConflict: "ScheduleConflictError",
    });
  });
});
