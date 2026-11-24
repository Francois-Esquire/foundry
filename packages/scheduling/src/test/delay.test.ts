import { Deferred, Effect, Ref, TestClock } from "effect";
import { describe, expect, test } from "vitest";
import { dueOccurrences, firstDue } from "../cadence";
import { makeMemoryScheduleStore } from "../store/memory";
import {
  fakeDispatch,
  inTestContext,
  startScheduler,
  target,
  testScheduler,
} from "./helpers/scheduler";

const delay = {
  afterSettleMs: 1000,
  initialDelayMs: 500,
  kind: "delay",
} as const;

const scheduledTimes = (
  requests: readonly { readonly scheduledFor: number }[]
) => requests.map((request) => request.scheduledFor);

describe("delay cadence", () => {
  test("is first dispatched after the initial delay, then once per settle plus the delay, using the job's own settle time", async () => {
    const result = await testScheduler(
      (scheduler, dispatch) =>
        Effect.gen(function* () {
          yield* scheduler.register({ cadence: delay, id: "poll", target });
          yield* TestClock.adjust(500);
          const whileOpen = yield* scheduler.cursor("poll");
          yield* TestClock.adjust(5000);
          yield* dispatch.settle("job:poll:500", "complete", 5200);
          yield* TestClock.adjust(500);
          const afterSettle = yield* scheduler.cursor("poll");
          yield* TestClock.adjust(200);
          return {
            afterSettle,
            dispatched: scheduledTimes(yield* Ref.get(dispatch.submitted)),
            whileOpen,
          };
        }),
      { settlePollMs: 500 }
    );
    expect(result.whileOpen).toMatchObject({
      activeJobId: "job:poll:500",
      nextDueAt: null,
    });
    expect(result.afterSettle).toMatchObject({
      lastSettledAt: 5200,
      nextDueAt: 6200,
    });
    expect(result.dispatched).toEqual([500, 6200]);
  });

  test("after a long pause it is dispatched once, and a failed dispatch keeps it due and retries with growing backoff", async () => {
    const result = await testScheduler(
      (scheduler, dispatch) =>
        Effect.gen(function* () {
          yield* scheduler.register({
            cadence: delay,
            id: "poll",
            state: "paused",
            target,
          });
          yield* TestClock.adjust(10_000);
          yield* Ref.set(dispatch.failNext, 3);
          yield* scheduler.resume("poll");
          yield* TestClock.adjust(0);
          yield* TestClock.adjust(100 + 200 + 399);
          const stillDue = yield* scheduler.cursor("poll");
          const beforeBackoffEnds = (yield* Ref.get(dispatch.submitted)).length;
          yield* TestClock.adjust(1);
          return {
            beforeBackoffEnds,
            dispatched: scheduledTimes(yield* Ref.get(dispatch.submitted)),
            stillDue,
          };
        }),
      { retryDelayMs: 100, settlePollMs: 50, syncIntervalMs: 50 }
    );
    expect(result.stillDue?.nextDueAt).toBe(500);
    expect(result.beforeBackoffEnds).toBe(0);
    expect(result.dispatched).toEqual([500]);
  });

  test("a peer that loses the claim after another dispatched and settled keeps that peer's advanced cursor", async () => {
    const result = await inTestContext(
      Effect.gen(function* () {
        const store = yield* makeMemoryScheduleStore;
        const dispatch = yield* fakeDispatch;
        const gate = yield* Deferred.make<void>();
        const late = yield* startScheduler(
          {
            ...store,
            claim: (occurrence, replacing, exclusive) =>
              Effect.zipRight(
                Deferred.await(gate),
                store.claim(occurrence, replacing, exclusive)
              ),
          },
          dispatch,
          { settlePollMs: 100 }
        );
        yield* late.register({ cadence: delay, id: "poll", target });
        yield* TestClock.adjust(500);
        yield* startScheduler(store, dispatch, { settlePollMs: 100 });
        yield* TestClock.adjust(0);
        yield* dispatch.settle("job:poll:500", "complete", 600);
        yield* TestClock.adjust(100);
        yield* Deferred.succeed(gate, undefined);
        yield* TestClock.adjust(0);
        const afterLoss = yield* store.getCursor("poll");
        yield* TestClock.adjust(1000);
        return {
          afterLoss,
          dispatched: scheduledTimes(yield* Ref.get(dispatch.submitted)),
        };
      })
    );
    expect(result.afterLoss).toMatchObject({
      lastSettledAt: 600,
      nextDueAt: 1600,
    });
    expect(result.dispatched).toEqual([500, 1600]);
  });

  test("registration rejects a non-positive delay and overlap or misfire policies other than skip and run-once", async () => {
    const refused = await testScheduler((scheduler) =>
      Effect.all(
        [
          { cadence: { afterSettleMs: 0, kind: "delay" } as const },
          { cadence: delay, overlap: "allow" } as const,
          { cadence: delay, overlap: "cancel-previous" } as const,
          { cadence: delay, misfire: "skip" } as const,
        ].map((input) =>
          Effect.flip(scheduler.register({ ...input, id: "bad", target }))
        )
      )
    );
    expect(refused.map((error) => error._tag)).toEqual([
      "InvalidCadenceError",
      "InvalidCadenceError",
      "InvalidCadenceError",
      "InvalidCadenceError",
    ]);
  });

  test("a due delay is dispatched at its due time alone, however late it is seen", () => {
    expect(firstDue({ afterSettleMs: 1000, kind: "delay" }, 0)).toBe(1000);
    expect(dueOccurrences(delay, 500, 1_000_000, "run-once")).toEqual({
      nextDueAt: null,
      skipped: [],
      toDispatch: 500,
    });
  });
});
