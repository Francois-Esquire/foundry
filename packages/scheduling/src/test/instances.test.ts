import { closeInstance, openInstance } from "@foundry/lib/instance-identity";
import { thisProcess } from "@foundry/lib/node/process-identity";
import { Deferred, Effect, Fiber, Ref, TestClock } from "effect";
import { describe, expect, test } from "vitest";
import { nodeSchedulerOptions } from "../node";
import { ScheduleStore } from "../store/index";
import { makeMemoryScheduleStore } from "../store/memory";
import {
  fakeDispatch,
  inTestContext,
  startScheduler,
  target,
  testScheduler,
} from "./helpers/scheduler";

const every = (everyMs: number) => ({ everyMs, kind: "interval" }) as const;

describe("Scheduler instances and retention", () => {
  test("settled and skipped occurrences beyond the limit are pruned, keeping open ones, and the latest is readable", async () => {
    const result = await testScheduler(
      (scheduler) =>
        Effect.gen(function* () {
          const store = yield* ScheduleStore;
          yield* scheduler.register({
            cadence: every(1000),
            id: "tick",
            target,
          });
          yield* TestClock.adjust(10_000);
          return {
            kept: yield* store.listOccurrences({ scheduleId: "tick" }),
            latest: yield* scheduler.latestOccurrence("tick"),
          };
        }),
      { maxOccurrencesPerSchedule: 2 }
    );
    expect(
      result.kept.map((occurrence) => [
        occurrence.scheduledFor,
        occurrence.state.kind,
      ])
    ).toEqual(
      expect.arrayContaining([
        [1000, "dispatched"],
        [9000, "skipped"],
        [10_000, "skipped"],
      ])
    );
    expect(result.kept).toHaveLength(3);
    expect(result.latest?.scheduledFor).toBe(10_000);
  });

  test("a claim held by another live scheduler in this process is left alone until that scheduler closes", async () => {
    const peer = openInstance(thisProcess());
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
              claimedAt: 0,
              kind: "claimed",
              lease: { claimedAt: 0, owner: peer },
            },
          });
          yield* TestClock.adjust(1000);
          const whilePeerLives = (yield* Ref.get(dispatch.submitted)).length;
          closeInstance(peer);
          yield* TestClock.adjust(500);
          return {
            afterPeerCloses: (yield* Ref.get(dispatch.submitted)).length,
            whilePeerLives,
          };
        }),
      nodeSchedulerOptions({ settlePollMs: 500 })
    );
    expect(result).toEqual({ afterPeerCloses: 1, whilePeerLives: 0 });
  });

  test("a scheduler whose dispatch fails releases its claim, so another live scheduler dispatches the occurrence at once", async () => {
    const dispatched = await inTestContext(
      Effect.gen(function* () {
        const store = yield* makeMemoryScheduleStore;
        const dispatch = yield* fakeDispatch;
        const failing = yield* startScheduler(store, dispatch, {
          retryDelayMs: 60_000,
        });
        yield* failing.register({
          cadence: { at: 1000, kind: "once" },
          id: "launch",
          target,
        });
        yield* Ref.set(dispatch.failNext, 1);
        yield* TestClock.adjust(1000);
        yield* startScheduler(store, dispatch);
        yield* TestClock.adjust(0);
        return (yield* Ref.get(dispatch.submitted)).map(
          (request) => request.idempotencyKey
        );
      })
    );
    expect(dispatched).toEqual(["launch:1000"]);
  });

  test("with a sync interval the loop notices a schedule another writer stored without waking it", async () => {
    const dispatched = await testScheduler(
      (_scheduler, dispatch) =>
        Effect.gen(function* () {
          const store = yield* ScheduleStore;
          yield* TestClock.adjust(1);
          yield* store.commit({
            cursors: [{ nextDueAt: 500, scheduleId: "external" }],
            schedules: [
              {
                cadence: every(10_000),
                createdAt: 0,
                id: "external",
                misfire: "run-once",
                overlap: "skip",
                state: "active",
                target,
              },
            ],
          });
          yield* TestClock.adjust(999);
          return (yield* Ref.get(dispatch.submitted)).map(
            (request) => request.idempotencyKey
          );
        }),
      { syncIntervalMs: 1000 }
    );
    expect(dispatched).toEqual(["external:500"]);
  });

  test("pause retries on schedule conflict instead of overwriting a concurrent register", async () => {
    const stored = await inTestContext(
      Effect.gen(function* () {
        const store = yield* makeMemoryScheduleStore;
        const dispatch = yield* fakeDispatch;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const gated = yield* Ref.make(true);
        const pausing = yield* startScheduler(
          {
            ...store,
            commit: (write) =>
              Effect.gen(function* () {
                const shouldGate =
                  write.expectedSchedules !== undefined &&
                  (yield* Ref.getAndSet(gated, false));
                if (shouldGate) {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
                return yield* store.commit(write);
              }),
          },
          dispatch
        );
        const updating = yield* startScheduler(store, dispatch);
        yield* updating.register({
          cadence: every(1000),
          id: "sync",
          target,
        });
        const pauseFiber = yield* Effect.fork(pausing.pause("sync"));
        yield* Deferred.await(entered);
        const updatedTarget = {
          handler: { name: "sync-v2" },
          input: { full: false },
        };
        yield* updating.register({
          cadence: every(5000),
          id: "sync",
          target: updatedTarget,
        });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pauseFiber);
        return yield* store.getSchedule("sync");
      })
    );
    expect(stored).toMatchObject({
      cadence: every(5000),
      state: "paused",
      target: { handler: { name: "sync-v2" }, input: { full: false } },
    });
  });

  test("separate schedulers serialize overlap: skip across in-flight claims", async () => {
    const dispatched = await inTestContext(
      Effect.gen(function* () {
        const store = yield* makeMemoryScheduleStore;
        const dispatch = yield* fakeDispatch;
        const submitting = yield* Deferred.make<void>();
        const releaseSubmit = yield* Deferred.make<void>();
        const firstSubmit = yield* Ref.make(true);
        const slowDispatch = {
          ...dispatch,
          layer: dispatch.layer,
        };
        const first = yield* startScheduler(
          store,
          {
            ...slowDispatch,
            layer: dispatch.layer.pipe((layer) => layer),
          },
          { settlePollMs: 500 }
        );
        yield* first.register({
          cadence: every(1000),
          id: "solo",
          overlap: "skip",
          target,
        });
        const storeWithGate = {
          ...store,
          claim: (
            occurrence: Parameters<typeof store.claim>[0],
            replacing?: Parameters<typeof store.claim>[1],
            exclusive?: boolean
          ) =>
            Effect.gen(function* () {
              const won = yield* store.claim(occurrence, replacing, exclusive);
              if (won && (yield* Ref.getAndSet(firstSubmit, false))) {
                yield* Deferred.succeed(submitting, undefined);
                yield* Deferred.await(releaseSubmit);
              }
              return won;
            }),
        };
        const peerA = yield* startScheduler(storeWithGate, dispatch, {
          settlePollMs: 500,
        });
        const peerB = yield* startScheduler(store, dispatch, {
          settlePollMs: 500,
        });
        const firstTrigger = yield* Effect.fork(peerA.triggerNow("solo"));
        yield* Deferred.await(submitting);
        yield* TestClock.adjust(10);
        const secondTrigger = yield* Effect.fork(peerB.triggerNow("solo"));
        yield* TestClock.adjust(0);
        yield* Deferred.succeed(releaseSubmit, undefined);
        yield* Fiber.join(firstTrigger);
        yield* Fiber.join(secondTrigger);
        return yield* Ref.get(dispatch.submitted);
      })
    );
    expect(dispatched).toHaveLength(1);
  });

  test("manual tick wakes the loop when it settles an open delay job with an earlier nextDueAt", async () => {
    const dispatched = await testScheduler(
      (scheduler, dispatch) =>
        Effect.gen(function* () {
          yield* scheduler.register({
            cadence: { afterSettleMs: 200, initialDelayMs: 100, kind: "delay" },
            id: "poll",
            target,
          });
          yield* TestClock.adjust(100);
          yield* dispatch.settle("job:poll:100", "complete", 100);
          yield* scheduler.tick;
          yield* TestClock.adjust(200);
          return (yield* Ref.get(dispatch.submitted)).map(
            (request) => request.scheduledFor
          );
        }),
      { settlePollMs: 10_000 }
    );
    expect(dispatched).toEqual([100, 300]);
  });
});
