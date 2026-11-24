import { Queue, type RunOutcome } from "@foundry/queue";
import { Effect, Layer, Ref, TestClock, TestContext } from "effect";
import { describe, expect, test } from "vitest";
import { QueueDispatchLayer } from "../queue";
import { Scheduler } from "../scheduler";
import { MemoryScheduleStore } from "../store/memory";
import { target, testScheduler } from "./helpers/scheduler";

const every = (everyMs: number) => ({ everyMs, kind: "interval" }) as const;

const keys = (requests: readonly { readonly idempotencyKey: string }[]) =>
  requests.map((request) => request.idempotencyKey);

describe("Scheduler", () => {
  test("the loop sleeps until each due time and dispatches one occurrence per slot", async () => {
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
        yield* dispatch.settle("job:skip:1000", "completed");
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

  test("after a long pause, run-once fires the latest missed slot and skip fires nothing", async () => {
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

  test("composed with the queue, a parked job counts as open until its wait resolves", async () => {
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
              context.resolvedWaits.has("ok")
                ? { kind: "completed", output: "synced" }
                : {
                    kind: "parked",
                    wait: {
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
          const [wait] = yield* queue.listWaits({ state: "pending" });
          if (wait !== undefined) {
            yield* queue.resolveWait(wait.id, true);
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
      ["sync", "sync:1000", "completed"],
      ["sync", "sync:3000", "waiting"],
    ]);
  });
});
