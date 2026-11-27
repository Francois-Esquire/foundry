import { claimRun, settleRun } from "@foundry/queue";
import { makeMemoryQueueStore } from "@foundry/queue/store/memory";
import { Effect, Exit, TestClock, TestContext } from "effect";
import { describe, expect, test } from "vitest";
import { createSchedulerClient } from "../client";
import { evaluateDueSchedules } from "../evaluator";
import { queueDispatchOver, statelessQueueDispatch } from "../queue";
import { makeMemoryScheduleStore } from "../store/memory";
import { fakeDispatch, target, testScheduler } from "./helpers/scheduler";

const inTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));

describe("Stateless scheduling evaluation", () => {
  test("evaluateDueSchedules returns decided occurrences and soonest alarm, dispatching via statelessQueueDispatch without daemons", async () => {
    const result = await inTestClock(
      Effect.gen(function* () {
        const scheduleStore = yield* makeMemoryScheduleStore;
        const queueStore = yield* makeMemoryQueueStore;
        const dispatch = statelessQueueDispatch(queueStore);

        yield* scheduleStore.commit({
          cursors: [{ nextDueAt: 1000, scheduleId: "sync" }],
          schedules: [
            {
              cadence: { everyMs: 1000, kind: "interval" },
              createdAt: 0,
              id: "sync",
              misfire: "run-once",
              overlap: "skip",
              state: "active",
              target,
            },
          ],
        });

        const before = yield* evaluateDueSchedules({
          dispatch,
          now: 500,
          store: scheduleStore,
        });

        const atFirst = yield* evaluateDueSchedules({
          dispatch,
          now: 1000,
          settlePollMs: 5000,
          store: scheduleStore,
        });

        const whileOpen = yield* evaluateDueSchedules({
          dispatch,
          now: 2000,
          store: scheduleStore,
        });

        const claimed = yield* claimRun(queueStore);
        if (claimed === undefined) {
          return yield* Effect.dieMessage("expected queued job from schedule");
        }
        yield* TestClock.adjust(2500);
        yield* settleRun(
          queueStore,
          claimed.run.id,
          claimed.lease,
          Exit.succeed({ kind: "complete", output: "ok" })
        );

        const afterSettle = yield* evaluateDueSchedules({
          dispatch,
          now: 3000,
          store: scheduleStore,
        });

        const jobs = yield* queueStore.listJobs();
        return { afterSettle, atFirst, before, jobs, whileOpen };
      })
    );

    expect(result.before).toEqual({ decided: [], errors: [], soonest: 1000 });
    expect(result.atFirst.decided).toHaveLength(1);
    expect(result.atFirst.decided[0]?.state.kind).toBe("dispatched");
    expect(result.atFirst.soonest).toBe(2000);
    expect(result.whileOpen.decided[0]?.state).toMatchObject({
      kind: "skipped",
      reason: "overlap",
    });
    expect(result.afterSettle.decided[0]?.state.kind).toBe("dispatched");
    expect(result.afterSettle.soonest).toBe(4000);
    expect(result.jobs.map((job) => job.policy.idempotencyKey)).toEqual([
      "sync:1000",
      "sync:3000",
    ]);
  });

  test("queueDispatchOver supports overlap cancel-previous against stateless queue store", async () => {
    const result = await inTestClock(
      Effect.gen(function* () {
        const scheduleStore = yield* makeMemoryScheduleStore;
        const queueStore = yield* makeMemoryQueueStore;
        const base = statelessQueueDispatch(queueStore);
        const cancelled: string[] = [];
        const dispatch = queueDispatchOver({
          cancel: (id, reason) =>
            Effect.tap(
              Effect.promise(() => Effect.runPromise(base.cancel(id, reason))),
              () =>
                Effect.sync(() => {
                  cancelled.push(id);
                })
            ),
          getJob: queueStore.getJob,
          submit: (input) =>
            Effect.flatMap(
              base.submit({
                idempotencyKey: input.policy?.idempotencyKey ?? "k",
                scheduledFor: 0,
                scheduleId: input.links?.triggerId ?? "s",
                target: {
                  handler: input.handler,
                  input: input.input ?? null,
                  ...(input.policy === undefined
                    ? {}
                    : { policy: input.policy }),
                  ...(input.pool === undefined ? {} : { pool: input.pool }),
                },
              }),
              ({ jobId }) =>
                Effect.flatMap(
                  queueStore.getJob(jobId as `jb-${string}`),
                  (j) =>
                    j === undefined
                      ? Effect.dieMessage("missing")
                      : Effect.succeed(j)
                )
            ),
        });

        yield* scheduleStore.commit({
          cursors: [{ nextDueAt: 1000, scheduleId: "supersede" }],
          schedules: [
            {
              cadence: { everyMs: 1000, kind: "interval" },
              createdAt: 0,
              id: "supersede",
              misfire: "run-once",
              overlap: "cancel-previous",
              state: "active",
              target,
            },
          ],
        });

        yield* evaluateDueSchedules({
          dispatch,
          now: 1000,
          store: scheduleStore,
        });
        yield* evaluateDueSchedules({
          dispatch,
          now: 2000,
          store: scheduleStore,
        });

        const jobs = yield* queueStore.listJobs();
        return { cancelled, jobs };
      })
    );

    expect(result.cancelled).toHaveLength(1);
    expect(result.jobs.map((job) => job.state.kind)).toEqual([
      "cancelled",
      "pending",
    ]);
  });

  test("Scheduler.tickWithNext and SchedulerClient.tickWithNext return decided and soonest", async () => {
    const tickResult = await testScheduler((scheduler) =>
      Effect.gen(function* () {
        yield* scheduler.register({
          cadence: { everyMs: 1000, kind: "interval" },
          id: "heartbeat",
          target,
        });
        return yield* scheduler.tickWithNext;
      })
    );
    expect(tickResult).toEqual({ decided: [], soonest: 1000 });

    const dispatch = await Effect.runPromise(fakeDispatch);
    const client = createSchedulerClient({ dispatch: dispatch.layer });
    try {
      await client.register({
        cadence: { everyMs: 60_000, kind: "interval" },
        id: "hourly-ish",
        target,
      });
      const next = await client.tickWithNext();
      expect(next.decided).toEqual([]);
      expect(typeof next.soonest).toBe("number");
    } finally {
      await client.dispose();
    }
  });

  test("concurrent evaluateDueSchedules do not steal live claims, recover stale claims via claimTtlMs, and isolate per-schedule errors", async () => {
    const result = await inTestClock(
      Effect.gen(function* () {
        const scheduleStore = yield* makeMemoryScheduleStore;
        const queueStore = yield* makeMemoryQueueStore;
        let releaseFirst!: () => void;
        const firstBlocked = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        let dispatchedCount = 0;
        const base = statelessQueueDispatch(queueStore);
        const blockingDispatch: typeof base = {
          ...base,
          submit: (req) =>
            Effect.gen(function* () {
              if (req.scheduleId === "good") {
                dispatchedCount += 1;
                if (dispatchedCount === 1) {
                  yield* Effect.promise(() => firstBlocked);
                }
              }
              return yield* base.submit(req);
            }),
        };

        yield* scheduleStore.commit({
          cursors: [
            { nextDueAt: 1000, scheduleId: "bad" },
            { nextDueAt: 1000, scheduleId: "good" },
          ],
          schedules: [
            {
              cadence: { everyMs: 1000, kind: "interval" },
              createdAt: 0,
              id: "bad",
              misfire: "run-once",
              overlap: "skip",
              state: "active",
              target: {
                handler: { name: "bad" },
                input: null,
                policy: { retry: { maxAttempts: 0 } },
              },
            },
            {
              cadence: { everyMs: 1000, kind: "interval" },
              createdAt: 0,
              id: "good",
              misfire: "run-once",
              overlap: "skip",
              state: "active",
              target,
            },
          ],
        });

        const firstFiber = yield* Effect.fork(
          evaluateDueSchedules({
            dispatch: blockingDispatch,
            now: 1000,
            store: scheduleStore,
          })
        );
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 10)));

        const second = yield* evaluateDueSchedules({
          dispatch: blockingDispatch,
          now: 2000,
          store: scheduleStore,
        });
        releaseFirst();
        const first = yield* Effect.fromFiber(firstFiber);

        yield* scheduleStore.commit({
          cursors: [{ nextDueAt: 5000, scheduleId: "once-stale" }],
          occurrences: [
            {
              id: "once-stale:5000",
              scheduledFor: 5000,
              scheduleId: "once-stale",
              state: {
                claimedAt: 5000,
                kind: "claimed",
                lease: {
                  claimedAt: 5000,
                  owner: {
                    instanceId: "dead-isolate",
                    pid: 0,
                    started: "other",
                  },
                },
              },
            },
          ],
          schedules: [
            {
              cadence: { at: 5000, kind: "once" },
              createdAt: 0,
              id: "once-stale",
              misfire: "run-once",
              overlap: "skip",
              state: "active",
              target,
            },
          ],
        });

        const recovered = yield* evaluateDueSchedules({
          claimTtlMs: 1000,
          dispatch: base,
          now: 7000,
          store: scheduleStore,
        });

        return { dispatchedCount, first, recovered, second };
      })
    );

    expect(result.first.errors.map((e) => e.scheduleId)).toEqual(["bad"]);
    expect(result.first.decided[0]?.scheduleId).toBe("good");
    expect(result.first.decided[0]?.state.kind).toBe("dispatched");
    expect(result.dispatchedCount).toBe(1);
    expect(result.second.decided[0]?.state).toMatchObject({
      kind: "skipped",
      reason: "already-claimed",
    });
    expect(
      result.recovered.decided.find((o) => o.scheduleId === "once-stale")?.state
        .kind
    ).toBe("dispatched");
  });
});
