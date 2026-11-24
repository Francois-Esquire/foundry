import { Queue, type RunOutcome } from "@foundry/queue";
import { Effect, Layer, Ref, TestClock, TestContext } from "effect";
import { describe, expect, test } from "vitest";
import { StoreError } from "../domain";
import { QueueDispatchLayer } from "../queue";
import { Scheduler } from "../scheduler";
import { ScheduleStore } from "../store/index";
import { MemoryScheduleStore, makeMemoryScheduleStore } from "../store/memory";
import { target, testScheduler } from "./helpers/scheduler";

const every = (everyMs: number) => ({ everyMs, kind: "interval" }) as const;

const keys = (requests: readonly { readonly idempotencyKey: string }[]) =>
  requests.map((request) => request.idempotencyKey);

describe("Scheduler", () => {
  test("the loop sleeps until each due time and dispatches one occurrence per due time", async () => {
    const result = await testScheduler((scheduler, dispatch) =>
      Effect.gen(function* () {
        yield* scheduler.register({
          cadence: every(1000),
          id: "sync",
          overlap: "allow",
          target,
        });
        yield* TestClock.adjust(999);
        const early = yield* Ref.get(dispatch.submitted);
        yield* TestClock.adjust(2001);
        return {
          cursor: yield* scheduler.cursor("sync"),
          early,
          submitted: yield* Ref.get(dispatch.submitted),
        };
      })
    );
    expect(result.early).toEqual([]);
    expect(keys(result.submitted)).toEqual([
      "sync:1000",
      "sync:2000",
      "sync:3000",
    ]);
    expect(result.submitted[0]).toMatchObject({
      scheduledFor: 1000,
      scheduleId: "sync",
      target,
    });
    expect(result.cursor).toMatchObject({
      activeJobId: "job:sync:3000",
      lastScheduledFor: 3000,
      nextDueAt: 4000,
    });
  });

  test("an occurrence is claimed once, and a claim whose dispatch failed is resumed on the next tick", async () => {
    const result = await testScheduler((scheduler, dispatch) =>
      Effect.gen(function* () {
        yield* scheduler.register({
          cadence: every(60_000),
          id: "sync",
          overlap: "allow",
          target,
        });
        const first = yield* scheduler.triggerNow("sync");
        const again = yield* scheduler.triggerNow("sync");
        yield* Ref.set(dispatch.failNext, 1);
        yield* TestClock.adjust(60_000);
        const failed = yield* Ref.get(dispatch.submitted);
        yield* scheduler.tick;
        return {
          again,
          failed,
          first,
          resumed: yield* Ref.get(dispatch.submitted),
        };
      })
    );
    expect(result.first.state).toMatchObject({
      jobId: "job:sync:0",
      kind: "dispatched",
    });
    expect(result.again.state).toMatchObject({
      kind: "skipped",
      reason: "already-claimed",
    });
    expect(keys(result.failed)).toEqual(["sync:0"]);
    expect(keys(result.resumed)).toEqual(["sync:0", "sync:60000"]);
  });

  test("overlap skips while the previous job is open, allows it, or cancels it first", async () => {
    const result = await testScheduler((scheduler, dispatch) =>
      Effect.gen(function* () {
        for (const overlap of ["skip", "allow", "cancel-previous"] as const) {
          yield* scheduler.register({
            cadence: every(1000),
            id: overlap,
            overlap,
            target,
          });
        }
        yield* TestClock.adjust(2000);
        yield* dispatch.settle("job:skip:1000", "complete");
        yield* TestClock.adjust(1000);
        return {
          cancelled: yield* Ref.get(dispatch.cancelled),
          skipCursor: yield* scheduler.cursor("skip"),
          submitted: keys(yield* Ref.get(dispatch.submitted)),
        };
      })
    );
    expect(result.submitted.filter((key) => key.startsWith("skip:"))).toEqual([
      "skip:1000",
      "skip:3000",
    ]);
    expect(
      result.submitted.filter((key) => key.startsWith("allow:"))
    ).toHaveLength(3);
    expect(
      result.submitted.filter((key) => key.startsWith("cancel-previous:"))
    ).toHaveLength(3);
    expect(result.cancelled).toEqual([
      "job:cancel-previous:1000",
      "job:cancel-previous:2000",
    ]);
    expect(result.skipCursor).toMatchObject({
      activeJobId: "job:skip:3000",
      lastSettledAt: 3000,
    });
  });

  test("after a long pause, run-once fires the latest missed due time and skip fires nothing", async () => {
    const result = await testScheduler((scheduler, dispatch) =>
      Effect.gen(function* () {
        for (const misfire of ["run-once", "skip"] as const) {
          yield* scheduler.register({
            cadence: every(1000),
            id: misfire,
            misfire,
            target,
          });
          yield* scheduler.pause(misfire);
        }
        yield* TestClock.adjust(3500);
        const whilePaused = yield* Ref.get(dispatch.submitted);
        yield* scheduler.resume("run-once");
        yield* scheduler.resume("skip");
        yield* TestClock.adjust(0);
        return {
          skipCursor: yield* scheduler.cursor("skip"),
          submitted: keys(yield* Ref.get(dispatch.submitted)),
          whilePaused,
        };
      })
    );
    expect(result.whilePaused).toEqual([]);
    expect(result.submitted).toEqual(["run-once:3000"]);
    expect(result.skipCursor).toMatchObject({
      lastScheduledFor: 3000,
      nextDueAt: 4000,
    });
  });

  test("a paused schedule does not fire on time but can still be triggered now", async () => {
    const result = await testScheduler((scheduler, dispatch) =>
      Effect.gen(function* () {
        yield* scheduler.register({
          cadence: every(1000),
          id: "sync",
          state: "paused",
          target,
        });
        yield* TestClock.adjust(1500);
        const onTime = yield* Ref.get(dispatch.submitted);
        const manual = yield* scheduler.triggerNow("sync");
        return { manual, onTime };
      })
    );
    expect(result.onTime).toEqual([]);
    expect(result.manual).toMatchObject({
      id: "sync:1500",
      state: { jobId: "job:sync:1500", kind: "dispatched" },
    });
  });

  test("a claim whose owner is gone is taken over and dispatched under the occurrence's key", async () => {
    const gone = { pid: 7, started: "crashed" } as const;
    const submitted = await testScheduler(
      (scheduler, dispatch) =>
        Effect.gen(function* () {
          const store = yield* ScheduleStore;
          yield* scheduler.register({
            cadence: every(1000),
            id: "sync",
            target,
          });
          yield* store.claim({
            id: "sync:1000",
            scheduledFor: 1000,
            scheduleId: "sync",
            state: {
              claimedAt: 0,
              kind: "claimed",
              lease: { claimedAt: 0, owner: gone },
            },
          });
          yield* TestClock.adjust(1000);
          return keys(yield* Ref.get(dispatch.submitted));
        }),
      { isOwnerGone: (owner) => owner.pid === gone.pid }
    );
    expect(submitted).toEqual(["sync:1000"]);
  });

  test("a once schedule observes its dispatched job settle without another due time", async () => {
    const cursor = await testScheduler(
      (scheduler, dispatch) =>
        Effect.gen(function* () {
          yield* scheduler.register({
            cadence: { at: 1000, kind: "once" },
            id: "launch",
            target,
          });
          yield* TestClock.adjust(1000);
          yield* dispatch.settle("job:launch:1000", "complete");
          yield* TestClock.adjust(500);
          return yield* scheduler.cursor("launch");
        }),
      { settlePollMs: 500 }
    );
    expect(cursor).toEqual({
      lastScheduledFor: 1000,
      lastSettledAt: 1500,
      nextDueAt: null,
      scheduleId: "launch",
    });
  });

  test("the loop retries after a failed listing instead of sleeping until the next change", async () => {
    let failNext = false;
    const flaky = Layer.effect(
      ScheduleStore,
      Effect.map(makeMemoryScheduleStore, (store) => ({
        ...store,
        listSchedules: Effect.suspend(() => {
          const fail = failNext;
          failNext = false;
          return fail
            ? Effect.fail(new StoreError({ cause: "store down" }))
            : store.listSchedules;
        }),
      }))
    );
    const submitted = await testScheduler(
      (scheduler, dispatch) =>
        Effect.gen(function* () {
          yield* scheduler.register({
            cadence: every(1000),
            id: "sync",
            target,
          });
          yield* TestClock.adjust(0);
          failNext = true;
          yield* TestClock.adjust(1000);
          yield* TestClock.adjust(1000);
          return keys(yield* Ref.get(dispatch.submitted));
        }),
      { retryDelayMs: 1000 },
      flaky
    );
    expect(submitted).toEqual(["sync:2000"]);
  });

  test("composed with the queue, a suspended job counts as open until its suspension resolves", async () => {
    const layer = Scheduler.layer().pipe(
      Layer.provide(QueueDispatchLayer),
      Layer.provide(MemoryScheduleStore),
      Layer.provideMerge(Queue.memory())
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue;
          const scheduler = yield* Scheduler;
          yield* queue.register("sync", (context) =>
            Effect.succeed<RunOutcome>(
              context.resolutions.has("ok")
                ? { kind: "complete", output: "synced" }
                : {
                    kind: "suspended",
                    suspension: {
                      key: "ok",
                      kind: "human",
                      reason: "confirm",
                      request: null,
                    },
                  }
            )
          );
          yield* scheduler.register({
            cadence: every(1000),
            id: "sync",
            target,
          });
          yield* TestClock.adjust(2000);
          const [suspension] = yield* queue.listSuspensions({
            state: "pending",
          });
          if (suspension !== undefined) {
            yield* queue.resolveSuspension(suspension.id, true);
          }
          yield* TestClock.adjust(1000);
          return { jobs: yield* queue.listJobs() };
        })
      ).pipe(Effect.provide(layer), Effect.provide(TestContext.TestContext))
    );
    expect(
      result.jobs.map((job) => [
        job.links.triggerId,
        job.policy.idempotencyKey,
        job.state.kind,
      ])
    ).toEqual([
      ["sync", "sync:1000", "complete"],
      ["sync", "sync:3000", "suspended"],
    ]);
  });

  test("a paused schedule still settles its open dispatched job without firing again", async () => {
    const result = await testScheduler(
      (scheduler, dispatch) =>
        Effect.gen(function* () {
          yield* scheduler.register({
            cadence: every(1000),
            id: "sync",
            target,
          });
          yield* TestClock.adjust(1000);
          yield* scheduler.pause("sync");
          yield* TestClock.adjust(0);
          yield* dispatch.settle("job:sync:1000", "complete");
          yield* TestClock.adjust(1500);
          return {
            cursor: yield* scheduler.cursor("sync"),
            submitted: keys(yield* Ref.get(dispatch.submitted)),
          };
        }),
      { settlePollMs: 500 }
    );
    expect(result.submitted).toEqual(["sync:1000"]);
    expect(result.cursor).toMatchObject({
      lastScheduledFor: 1000,
      lastSettledAt: 1500,
      nextDueAt: 2000,
    });
    expect(result.cursor?.activeJobId).toBeUndefined();
  });

  test("a live peer claim on a once schedule stays retryable and is taken over if the peer dies", async () => {
    const peer = { pid: 99, started: "peer" } as const;
    let peerGone = false;
    const result = await testScheduler(
      (scheduler, dispatch) =>
        Effect.gen(function* () {
          const store = yield* ScheduleStore;
          yield* scheduler.register({
            cadence: { at: 1000, kind: "once" },
            id: "launch",
            target,
          });
          yield* store.claim({
            id: "launch:1000",
            scheduledFor: 1000,
            scheduleId: "launch",
            state: {
              claimedAt: 1000,
              kind: "claimed",
              lease: { claimedAt: 1000, owner: peer },
            },
          });
          yield* TestClock.adjust(1000);
          const whileAlive = yield* scheduler.cursor("launch");
          peerGone = true;
          yield* TestClock.adjust(500);
          return {
            afterTakeover: yield* scheduler.cursor("launch"),
            submitted: keys(yield* Ref.get(dispatch.submitted)),
            whileAlive,
          };
        }),
      {
        isOwnerGone: (owner) => peerGone && owner.pid === peer.pid,
        settlePollMs: 500,
      }
    );
    expect(result.whileAlive?.nextDueAt).toBe(1000);
    expect(result.submitted).toEqual(["launch:1000"]);
    expect(result.afterTakeover).toMatchObject({
      activeJobId: "job:launch:1000",
      lastScheduledFor: 1000,
      nextDueAt: null,
    });
  });
});
