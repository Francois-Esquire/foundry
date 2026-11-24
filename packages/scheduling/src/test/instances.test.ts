import { closeInstance, openInstance } from "@foundry/lib/instance-identity";
import { thisProcess } from "@foundry/lib/process-identity";
import { Effect, Ref, TestClock } from "effect";
import { describe, expect, test } from "vitest";
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
      { settlePollMs: 500 }
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
});
