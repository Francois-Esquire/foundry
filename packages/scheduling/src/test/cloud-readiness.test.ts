import { createTables } from "@foundry/lib/testing/sqlite";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { ScheduleDispatchService } from "../dispatch";
import { CursorConflictError } from "../domain";
import { DEFAULT_CLAIM_TTL_MS, evaluateDueSchedules } from "../evaluator";
import {
  pauseSchedule,
  recordSettlement,
  registerSchedule,
  resumeSchedule,
  triggerScheduleNow,
  unregisterSchedule,
} from "../stateless";
import { makeMemoryScheduleStore } from "../store/memory";
import {
  makeSqliteScheduleStore,
  type ScheduleDatabase,
} from "../store/sqlite";
import { schedulingTables } from "../store/tables";

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

function fakeDispatch(): {
  readonly dispatch: ScheduleDispatchService;
  readonly submits: string[];
} {
  const submits: string[] = [];
  return {
    dispatch: {
      cancel: () => Effect.void,
      status: () => Effect.succeed({ kind: "open" }),
      submit: (req) =>
        Effect.sync(() => {
          submits.push(req.idempotencyKey);
          return { jobId: `jb-${submits.length}` };
        }),
    },
    submits,
  };
}

describe("Scheduling cloud-native stateless seams", () => {
  it.each(["memory", "sqlite"] as const)(
    "supports stateless CRUD, recordSettlement, listDueSchedules/limit/hasMore, and finite claimTtlMs on %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? makeSqliteScheduleStore({
              database: await openDatabase(),
              scope: "sched-cloud",
            })
          : await Effect.runPromise(makeMemoryScheduleStore);

      const { dispatch, submits } = fakeDispatch();

      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          let ev = 0;
          const nextEventId = () => {
            ev += 1;
            return `ev-custom-${ev}`;
          };

          const s1 = yield* registerSchedule(
            store,
            {
              cadence: { everyMs: 1000, kind: "interval" },
              id: "sched-1",
              target: { handler: { name: "h1" }, input: null },
            },
            { nextEventId, now: 0 }
          );
          yield* registerSchedule(
            store,
            {
              cadence: { everyMs: 1000, kind: "interval" },
              id: "sched-2",
              target: { handler: { name: "h2" }, input: null },
            },
            { nextEventId, now: 0 }
          );

          const paused = yield* pauseSchedule(store, s1.id, { now: 100 });
          expect(paused.state).toBe("paused");
          const resumed = yield* resumeSchedule(store, s1.id, { now: 200 });
          expect(resumed.state).toBe("active");

          const page1 = yield* evaluateDueSchedules({
            dispatch,
            limit: 1,
            nextEventId,
            now: 1000,
            store,
          });
          expect(page1.hasMore).toBe(true);
          expect(page1.decided).toHaveLength(1);

          const [occ1] = page1.decided;
          if (!occ1) {
            throw new Error("expected first occurrence");
          }
          const settled = yield* recordSettlement(store, occ1.id, "complete", {
            nextEventId,
            settledAt: 1500,
          });
          expect(settled?.state.kind).toBe("settled");

          const page2 = yield* evaluateDueSchedules({
            dispatch,
            limit: 10,
            nextEventId,
            now: 1000,
            store,
          });
          expect(page2.hasMore).toBe(false);
          expect(page2.decided).toHaveLength(1);

          const triggered = yield* triggerScheduleNow(store, dispatch, s1.id, {
            nextEventId,
            now: 1600,
          });
          expect(triggered.state.kind).toBe("dispatched");

          yield* unregisterSchedule(store, "sched-2", { now: 1700 });
          const gone = yield* store.getSchedule("sched-2");

          return { gone, submits: submits.length };
        })
      );

      expect(outcome).toEqual({ gone: undefined, submits: 3 });
    }
  );

  it("guards against double dispatch on CursorConflictError retries and recovers expired claims via DEFAULT_CLAIM_TTL_MS", async () => {
    const inner = await Effect.runPromise(makeMemoryScheduleStore);
    const { dispatch, submits } = fakeDispatch();

    let injectedConflict = false;
    const conflictingStore = {
      ...inner,
      commit(write: Parameters<typeof inner.commit>[0]) {
        if (!injectedConflict && (write.occurrences?.length ?? 0) > 0) {
          injectedConflict = true;
          return Effect.fail(
            new CursorConflictError({ scheduleId: "s-retry" })
          );
        }
        return inner.commit(write);
      },
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerSchedule(
          inner,
          {
            cadence: { everyMs: 1000, kind: "interval" },
            id: "s-retry",
            target: { handler: { name: "h" }, input: null },
          },
          { now: 0 }
        );
        const result = yield* evaluateDueSchedules({
          dispatch,
          now: 1000,
          store: conflictingStore,
        });
        expect(result.decided).toHaveLength(1);
        expect(submits).toHaveLength(1);
      })
    );

    const ttlStore = await Effect.runPromise(makeMemoryScheduleStore);
    const d2 = fakeDispatch();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerSchedule(
          ttlStore,
          {
            cadence: { at: 1000, kind: "once" },
            id: "s-ttl",
            target: { handler: { name: "h" }, input: null },
          },
          { now: 0 }
        );
        yield* ttlStore.claim(
          {
            id: "s-ttl:1000",
            scheduledFor: 1000,
            scheduleId: "s-ttl",
            state: {
              claimedAt: 1000,
              kind: "claimed",
              lease: {
                claimedAt: 1000,
                expiresAt: 1000 + DEFAULT_CLAIM_TTL_MS,
                owner: {
                  instanceId: "dead-isolate",
                  pid: 0,
                  started: "0",
                },
              },
            },
          },
          undefined,
          true
        );

        const afterExpiry = yield* evaluateDueSchedules({
          dispatch: d2.dispatch,
          now: 1000 + DEFAULT_CLAIM_TTL_MS + 1,
          store: ttlStore,
        });
        expect(afterExpiry.decided).toHaveLength(1);
        expect(afterExpiry.decided[0]?.state.kind).toBe("dispatched");
        expect(d2.submits).toEqual(["s-ttl:1000"]);
      })
    );
  });

  it.each(["memory", "sqlite"] as const)(
    "bounded evaluateDueSchedules({ limit }) observes settlement of fixed-delay schedules on %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? makeSqliteScheduleStore({
              database: await openDatabase(),
              scope: "sched-fixed-delay",
            })
          : await Effect.runPromise(makeMemoryScheduleStore);

      const settledJobs = new Map<string, number>();
      let nextJobSeq = 0;
      const dispatch: ScheduleDispatchService = {
        cancel: () => Effect.void,
        status: (jobId) => {
          const settledAt = settledJobs.get(jobId);
          return Effect.succeed(
            settledAt === undefined
              ? { kind: "open" }
              : { kind: "settled", outcome: "complete", settledAt }
          );
        },
        submit: () =>
          Effect.sync(() => {
            nextJobSeq += 1;
            return { jobId: `jb-delay-${nextJobSeq}` };
          }),
      };

      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          yield* registerSchedule(
            store,
            {
              cadence: { afterSettleMs: 5000, kind: "delay" },
              id: "delay-1",
              target: { handler: { name: "delay-handler" }, input: null },
            },
            { now: 0 }
          );

          const dispatched = yield* evaluateDueSchedules({
            dispatch,
            limit: 10,
            now: 5000,
            store,
          });
          const cursorWhileOpen = yield* store.getCursor("delay-1");
          const activeJobId = cursorWhileOpen?.activeJobId;
          if (activeJobId === undefined) {
            throw new Error("expected activeJobId after dispatch");
          }
          settledJobs.set(activeJobId, 6000);

          const settled = yield* evaluateDueSchedules({
            dispatch,
            limit: 10,
            now: 6500,
            store,
          });
          const cursorAfterSettle = yield* store.getCursor("delay-1");
          return {
            cursorAfterSettle,
            cursorWhileOpen,
            dispatched,
            settled,
          };
        })
      );

      expect(outcome.dispatched.decided).toHaveLength(1);
      expect(outcome.cursorWhileOpen?.nextDueAt).toBeNull();
      expect(outcome.cursorAfterSettle?.activeJobId).toBeUndefined();
      expect(outcome.cursorAfterSettle?.lastSettledAt).toBe(6000);
      expect(outcome.cursorAfterSettle?.nextDueAt).toBe(11_000);
      expect(outcome.settled.soonest).toBe(11_000);
    }
  );

  it.each(["memory", "sqlite"] as const)(
    "paused schedules do not starve active schedules in evaluateDueSchedules or pin nextDueAt on %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? makeSqliteScheduleStore({
              database: await openDatabase(),
              scope: "sched-paused-starve",
            })
          : await Effect.runPromise(makeMemoryScheduleStore);

      const { dispatch } = fakeDispatch();

      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          for (let index = 0; index < 15; index += 1) {
            const id = `paused-${index}`;
            yield* registerSchedule(
              store,
              {
                cadence: { everyMs: 100, kind: "interval" },
                id,
                state: "paused",
                target: { handler: { name: "paused" }, input: null },
              },
              { now: index * 10 }
            );
          }
          yield* registerSchedule(
            store,
            {
              cadence: { everyMs: 1000, kind: "interval" },
              id: "active-one",
              state: "active",
              target: { handler: { name: "active" }, input: null },
            },
            { now: 1000 }
          );

          const beforeEvalNextDue =
            store.nextDueAt === undefined ? undefined : yield* store.nextDueAt;
          const evaluated = yield* evaluateDueSchedules({
            dispatch,
            limit: 5,
            now: 2000,
            store,
          });
          const afterEvalNextDue =
            store.nextDueAt === undefined ? undefined : yield* store.nextDueAt;
          return { afterEvalNextDue, beforeEvalNextDue, evaluated };
        })
      );

      expect(outcome.beforeEvalNextDue).toBe(2000);
      expect(outcome.evaluated.hasMore).toBe(false);
      expect(outcome.evaluated.decided).toHaveLength(1);
      expect(outcome.evaluated.decided[0]?.scheduleId).toBe("active-one");
      expect(outcome.evaluated.decided[0]?.state.kind).toBe("dispatched");
      expect(outcome.afterEvalNextDue).toBe(3000);
    }
  );

  it.each(["memory", "sqlite"] as const)(
    "listDueSchedules still returns paused schedules with open dispatched occurrences so settlement runs on %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? makeSqliteScheduleStore({
              database: await openDatabase(),
              scope: "sched-paused-settle",
            })
          : await Effect.runPromise(makeMemoryScheduleStore);

      const settledJobs = new Map<string, number>();
      const submits: string[] = [];
      const dispatch: ScheduleDispatchService = {
        cancel: () => Effect.void,
        status: (jobId) => {
          const settledAt = settledJobs.get(jobId);
          return Effect.succeed(
            settledAt === undefined
              ? { kind: "open" }
              : { kind: "settled", outcome: "complete", settledAt }
          );
        },
        submit: (req) =>
          Effect.sync(() => {
            submits.push(req.idempotencyKey);
            return { jobId: `jb-paused-${submits.length}` };
          }),
      };

      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          yield* registerSchedule(
            store,
            {
              cadence: { everyMs: 1000, kind: "interval" },
              id: "paused-open",
              target: { handler: { name: "h" }, input: null },
            },
            { now: 0 }
          );

          const dispatched = yield* evaluateDueSchedules({
            dispatch,
            now: 1000,
            store,
          });
          yield* pauseSchedule(store, "paused-open", { now: 1200 });

          const dueWhilePausedWithActive =
            store.listDueSchedules === undefined
              ? []
              : yield* store.listDueSchedules(1500);

          const cursorBeforeSettle = yield* store.getCursor("paused-open");
          const activeJobId = cursorBeforeSettle?.activeJobId;
          if (activeJobId === undefined) {
            throw new Error("expected activeJobId while open");
          }
          settledJobs.set(activeJobId, 1800);

          const settled = yield* evaluateDueSchedules({
            dispatch,
            now: 2500,
            store,
          });
          const cursorAfterSettle = yield* store.getCursor("paused-open");
          const dueAfterSettle =
            store.listDueSchedules === undefined
              ? []
              : yield* store.listDueSchedules(3000);

          return {
            cursorAfterSettle,
            dispatched,
            dueAfterSettle,
            dueWhilePausedWithActive,
            settled,
            submits: [...submits],
          };
        })
      );

      expect(outcome.dispatched.decided).toHaveLength(1);
      expect(outcome.dueWhilePausedWithActive.map((s) => s.id)).toEqual([
        "paused-open",
      ]);
      expect(outcome.settled.decided).toEqual([]);
      expect(outcome.submits).toEqual(["paused-open:1000"]);
      expect(outcome.cursorAfterSettle?.activeJobId).toBeUndefined();
      expect(outcome.cursorAfterSettle?.lastSettledAt).toBe(1800);
      expect(outcome.dueAfterSettle).toEqual([]);
    }
  );

  it("does not allow a 60s worker to steal a claim whose explicit lease.expiresAt is 300s in the future", async () => {
    const store = await Effect.runPromise(makeMemoryScheduleStore);
    const { dispatch, submits } = fakeDispatch();

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerSchedule(
          store,
          {
            cadence: { at: 1000, kind: "once" },
            id: "s-long-lease",
            target: { handler: { name: "h" }, input: null },
          },
          { now: 0 }
        );
        yield* store.claim(
          {
            id: "s-long-lease:1000",
            scheduledFor: 1000,
            scheduleId: "s-long-lease",
            state: {
              claimedAt: 1000,
              kind: "claimed",
              lease: {
                claimedAt: 1000,
                expiresAt: 1000 + 300_000,
                owner: {
                  instanceId: "long-lease-worker",
                  pid: 0,
                  started: "0",
                },
              },
            },
          },
          undefined,
          true
        );

        const beforeExpiry = yield* evaluateDueSchedules({
          claimTtlMs: DEFAULT_CLAIM_TTL_MS,
          dispatch,
          now: 1000 + DEFAULT_CLAIM_TTL_MS + 1,
          store,
        });
        const occurrenceBeforeExpiry =
          yield* store.getOccurrence("s-long-lease:1000");

        const afterExpiry = yield* evaluateDueSchedules({
          claimTtlMs: DEFAULT_CLAIM_TTL_MS,
          dispatch,
          now: 1000 + 300_000,
          store,
        });

        return { afterExpiry, beforeExpiry, occurrenceBeforeExpiry };
      })
    );

    expect(outcome.beforeExpiry.decided.map((o) => o.state.kind)).toEqual([
      "skipped",
    ]);
    expect(outcome.occurrenceBeforeExpiry?.state.kind).toBe("claimed");
    expect(outcome.afterExpiry.decided).toHaveLength(1);
    expect(outcome.afterExpiry.decided[0]?.state.kind).toBe("dispatched");
    expect(submits).toEqual(["s-long-lease:1000"]);
  });

  it("preserves occurrence.claimed alongside occurrence.dispatched on CursorConflictError replay and reloads schedule on retry", async () => {
    const inner = await Effect.runPromise(makeMemoryScheduleStore);
    const { dispatch, submits } = fakeDispatch();
    const committedEventTypes: string[][] = [];

    let injectedConflict = false;
    const trackingStore = {
      ...inner,
      commit(write: Parameters<typeof inner.commit>[0]) {
        if (!injectedConflict && (write.occurrences?.length ?? 0) > 0) {
          injectedConflict = true;
          return Effect.fail(
            new CursorConflictError({ scheduleId: "s-replay-events" })
          );
        }
        return Effect.tap(inner.commit(write), () =>
          Effect.sync(() => {
            if (write.events && write.events.length > 0) {
              committedEventTypes.push(write.events.map((e) => e.type));
            }
          })
        );
      },
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerSchedule(
          inner,
          {
            cadence: { everyMs: 1000, kind: "interval" },
            id: "s-replay-events",
            target: { handler: { name: "h" }, input: null },
          },
          { now: 0 }
        );
        const result = yield* evaluateDueSchedules({
          dispatch,
          now: 1000,
          store: trackingStore,
        });
        expect(result.decided).toHaveLength(1);
      })
    );

    expect(submits).toEqual(["s-replay-events:1000"]);
    expect(committedEventTypes).toEqual([
      ["occurrence.claimed", "occurrence.dispatched"],
    ]);

    const pauseStore = await Effect.runPromise(makeMemoryScheduleStore);
    const dPause = fakeDispatch();
    let pausedOnConflict = false;
    const pausingStore = {
      ...pauseStore,
      commit(write: Parameters<typeof pauseStore.commit>[0]) {
        if (!pausedOnConflict && (write.occurrences?.length ?? 0) > 0) {
          pausedOnConflict = true;
          return Effect.flatMap(
            Effect.orDie(
              pauseSchedule(pauseStore, "s-paused-mid-retry", { now: 1000 })
            ),
            () =>
              Effect.fail(
                new CursorConflictError({ scheduleId: "s-paused-mid-retry" })
              )
          );
        }
        return pauseStore.commit(write);
      },
    };

    const pausedOutcome = await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerSchedule(
          pauseStore,
          {
            cadence: { everyMs: 1000, kind: "interval" },
            id: "s-paused-mid-retry",
            misfire: "skip",
            target: { handler: { name: "h" }, input: null },
          },
          { now: 0 }
        );
        const result = yield* evaluateDueSchedules({
          dispatch: dPause.dispatch,
          now: 2500,
          store: pausingStore,
        });
        const cursor = yield* pauseStore.getCursor("s-paused-mid-retry");
        return { cursor, result };
      })
    );

    expect(pausedOutcome.result.decided).toEqual([]);
    expect(pausedOutcome.cursor?.nextDueAt).toBe(1000);
    expect(dPause.submits).toEqual([]);
  });

  it("preserves remaining activeJobId in recordSettlement under overlap: allow and guards cadence updates with expectedCursors in registerSchedule", async () => {
    const store = await Effect.runPromise(makeMemoryScheduleStore);
    const { dispatch } = fakeDispatch();

    const overlapOutcome = await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerSchedule(
          store,
          {
            cadence: { everyMs: 1000, kind: "interval" },
            id: "s-allow",
            overlap: "allow",
            target: { handler: { name: "h" }, input: null },
          },
          { now: 0 }
        );
        const first = yield* evaluateDueSchedules({
          dispatch,
          now: 1000,
          store,
        });
        const second = yield* evaluateDueSchedules({
          dispatch,
          now: 2000,
          store,
        });
        const [occ1] = first.decided;
        const [occ2] = second.decided;
        if (
          occ1?.state.kind !== "dispatched" ||
          occ2?.state.kind !== "dispatched"
        ) {
          throw new Error("expected two dispatched occurrences");
        }
        yield* recordSettlement(store, occ2.id, "complete", {
          settledAt: 2500,
        });
        const cursorAfterLatestSettled = yield* store.getCursor("s-allow");
        yield* recordSettlement(store, occ1.id, "complete", {
          settledAt: 2600,
        });
        const cursorAfterAllSettled = yield* store.getCursor("s-allow");
        return {
          cursorAfterAllSettled,
          cursorAfterLatestSettled,
          firstJobId: occ1.state.jobId,
        };
      })
    );

    expect(overlapOutcome.cursorAfterLatestSettled?.activeJobId).toBe(
      overlapOutcome.firstJobId
    );
    expect(overlapOutcome.cursorAfterAllSettled?.activeJobId).toBeUndefined();

    const inner = await Effect.runPromise(makeMemoryScheduleStore);
    let injectedRace = false;
    const racingStore = {
      ...inner,
      commit(write: Parameters<typeof inner.commit>[0]) {
        if (!injectedRace && (write.expectedCursors?.length ?? 0) > 0) {
          injectedRace = true;
          return Effect.flatMap(inner.getCursor("s-cadence"), (current) => {
            if (current === undefined) {
              return inner.commit(write);
            }
            return Effect.flatMap(
              inner.commit({
                cursors: [
                  {
                    ...current,
                    activeJobId: "jb-concurrent",
                    lastSettledAt: 900,
                  },
                ],
                expectedCursors: [current],
              }),
              () => inner.commit(write)
            );
          });
        }
        return inner.commit(write);
      },
    };

    const cadenceCursor = await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerSchedule(
          inner,
          {
            cadence: { everyMs: 1000, kind: "interval" },
            id: "s-cadence",
            target: { handler: { name: "h" }, input: null },
          },
          { now: 0 }
        );
        yield* registerSchedule(
          racingStore,
          {
            cadence: { everyMs: 5000, kind: "interval" },
            id: "s-cadence",
            target: { handler: { name: "h" }, input: null },
          },
          { now: 1000 }
        );
        return yield* inner.getCursor("s-cadence");
      })
    );

    expect(injectedRace).toBe(true);
    expect(cadenceCursor).toEqual({
      activeJobId: "jb-concurrent",
      lastSettledAt: 900,
      nextDueAt: 6000,
      scheduleId: "s-cadence",
    });
  });
});
