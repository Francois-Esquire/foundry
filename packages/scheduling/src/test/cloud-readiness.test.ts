import { createPortableProcess } from "@foundry/lib/process-identity";
import { createTables } from "@foundry/lib/testing/sqlite";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CLAIM_TTL_MS,
  evaluateDueSchedules,
  occurrenceId,
  pauseSchedule,
  registerSchedule,
  resumeSchedule,
  type ScheduleDispatchService,
  unregisterSchedule,
} from "../index";
import { makeMemoryScheduleStore } from "../store/memory";
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

const makeDispatch = (
  statusOf: (
    jobId: string
  ) => Effect.Effect.Success<ReturnType<ScheduleDispatchService["status"]>>
) => {
  let seq = 0;
  const service: ScheduleDispatchService = {
    cancel: () => Effect.void,
    status: (jobId) => Effect.succeed(statusOf(jobId)),
    submit: () =>
      Effect.sync(() => {
        seq += 1;
        return { jobId: `jb-${seq}` };
      }),
  };
  return service;
};

describe("Scheduling cloud-readiness fixes", () => {
  it.each(["memory", "sqlite"] as const)(
    "uses listDueSchedules (including paused schedules with open jobs), nextDueAt, and stateless CRUD in %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? makeSqliteScheduleStore({
              database: await openDatabase(),
              scope: `sched-due-${kind}`,
            })
          : await Effect.runPromise(makeMemoryScheduleStore);

      let settled = false;
      const dispatch = makeDispatch(() =>
        settled
          ? { kind: "settled", outcome: "complete", settledAt: 2500 }
          : { kind: "open" }
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* registerSchedule(
            store,
            {
              cadence: { everyMs: 1000, kind: "interval" },
              id: "sched-a",
              target,
            },
            { now: 0 }
          );
          yield* registerSchedule(
            store,
            {
              cadence: { everyMs: 5000, kind: "interval" },
              id: "sched-b",
              target,
            },
            { now: 0 }
          );

          expect(yield* store.nextDueAt ?? Effect.succeed(undefined)).toBe(
            1000
          );
          expect(
            (yield* store.listDueSchedules?.(500) ?? Effect.succeed([])).map(
              (s) => s.id
            )
          ).toEqual([]);
          expect(
            (yield* store.listDueSchedules?.(1000) ?? Effect.succeed([])).map(
              (s) => s.id
            )
          ).toEqual(["sched-a"]);

          const fired = yield* evaluateDueSchedules({
            dispatch,
            now: 1000,
            store,
          });
          expect(fired.decided).toHaveLength(1);
          expect(fired.soonest).toBe(2000);

          yield* pauseSchedule(store, "sched-a", { now: 1500 });
          expect(
            (yield* store.listDueSchedules?.(2000) ?? Effect.succeed([])).map(
              (s) => s.id
            )
          ).toEqual(["sched-a"]);

          settled = true;
          yield* evaluateDueSchedules({ dispatch, now: 2500, store });
          expect(
            (yield* store.getCursor("sched-a"))?.activeJobId
          ).toBeUndefined();
          expect(
            (yield* store.listDueSchedules?.(2600) ?? Effect.succeed([])).map(
              (s) => s.id
            )
          ).toEqual([]);
          expect(yield* store.nextDueAt ?? Effect.succeed(undefined)).toBe(
            5000
          );

          const resumed = yield* resumeSchedule(store, "sched-a", {
            now: 3000,
          });
          expect(resumed.state).toBe("active");
          yield* unregisterSchedule(store, "sched-b", { now: 3000 });
          expect(yield* store.getSchedule("sched-b")).toBeUndefined();
        })
      );
    }
  );

  it("applies DEFAULT_CLAIM_TTL_MS and honors explicit lease.expiresAt when reclaiming stale claims", async () => {
    const store = await Effect.runPromise(makeMemoryScheduleStore);
    const dispatch = makeDispatch(() => ({ kind: "open" }));

    await Effect.runPromise(
      Effect.gen(function* () {
        expect(DEFAULT_CLAIM_TTL_MS).toBe(60_000);
        yield* registerSchedule(
          store,
          {
            cadence: { everyMs: 1000, kind: "interval" },
            id: "sched-ttl",
            target,
          },
          { now: 0 }
        );

        const claimed = yield* store.claim(
          {
            id: occurrenceId("sched-ttl", 1000),
            scheduledFor: 1000,
            scheduleId: "sched-ttl",
            state: {
              claimedAt: 1000,
              kind: "claimed",
              lease: {
                claimedAt: 1000,
                expiresAt: 1500,
                owner: {
                  ...createPortableProcess({
                    id: () => "remote",
                    now: () => 0,
                  }),
                  instanceId: "peer-1",
                },
              },
            },
          },
          undefined,
          true
        );
        expect(claimed).toBe(true);

        const before = yield* evaluateDueSchedules({
          claimTtlMs: 999_999,
          dispatch,
          now: 1400,
          store,
        });
        expect(before.decided[0]?.state.kind).toBe("skipped");

        const after = yield* evaluateDueSchedules({
          claimTtlMs: 999_999,
          dispatch,
          now: 1500,
          store,
        });
        expect(after.decided[0]?.state.kind).toBe("dispatched");
      })
    );
  });
});
