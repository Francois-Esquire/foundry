import { Effect, Ref, TestClock } from "effect";
import { describe, expect, test } from "vitest";
import { dueOccurrences, firstDue } from "../cadence";
import { target, testScheduler } from "./helpers/scheduler";

const delay = {
  afterSettleMs: 1000,
  initialDelayMs: 500,
  kind: "delay",
} as const;

const scheduledTimes = (
  requests: readonly { readonly scheduledFor: number }[]
) => requests.map((request) => request.scheduledFor);

describe("delay cadence", () => {
  test("first fires after the initial delay, then once per settle plus the delay, using the job's own settle time", async () => {
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
            fired: scheduledTimes(yield* Ref.get(dispatch.submitted)),
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
    expect(result.fired).toEqual([500, 6200]);
  });

  test("after a long pause it fires once, and a failed dispatch keeps it due and retries with growing backoff", async () => {
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
            fired: scheduledTimes(yield* Ref.get(dispatch.submitted)),
            stillDue,
          };
        }),
      { retryDelayMs: 100, settlePollMs: 50, syncIntervalMs: 50 }
    );
    expect(result.stillDue?.nextDueAt).toBe(500);
    expect(result.beforeBackoffEnds).toBe(0);
    expect(result.fired).toEqual([500]);
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

  test("a due delay fires at its due time alone, however late it is seen", () => {
    expect(firstDue({ afterSettleMs: 1000, kind: "delay" }, 0)).toBe(1000);
    expect(dueOccurrences(delay, 500, 1_000_000, "run-once")).toEqual({
      nextDueAt: null,
      skipped: [],
      toFire: 500,
    });
  });
});
