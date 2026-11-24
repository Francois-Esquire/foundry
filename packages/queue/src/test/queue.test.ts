import type { JsonValue } from "@foundry/lib/json";
import { Chunk, Deferred, Effect, Fiber, Stream, TestClock } from "effect";
import { describe, expect, test } from "vitest";
import type { Failure, RunOutcome } from "../domain";
import type { RunContext } from "../queue";
import { awaitJob, flush, handler, testQueue } from "./helpers/queue";

const done = (outcome: RunOutcome) => outcome;
const completed = (output: JsonValue = null) =>
  Effect.succeed(done({ kind: "completed", output }));

describe("Queue", () => {
  test("submitting with a known idempotency key returns the existing job and does the work once", async () => {
    const result = await testQueue((queue) =>
      Effect.gen(function* () {
        let calls = 0;
        yield* queue.register("work", () =>
          Effect.suspend(() => {
            calls += 1;
            return completed(calls);
          })
        );
        const policy = { idempotencyKey: "nightly" };
        const first = yield* queue.submit({ handler, policy });
        const second = yield* queue.submit({ handler, policy });
        const job = yield* awaitJob(queue, first.id);
        return { calls, first, job, second };
      })
    );
    expect(result.second.id).toBe(result.first.id);
    expect(result.calls).toBe(1);
    expect(result.job.state).toMatchObject({ kind: "completed", output: 1 });
  });

  test("a pool runs at most its limit, and resizing or pausing it takes effect immediately", async () => {
    const result = await testQueue(
      (queue) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          yield* queue.register("work", () =>
            Effect.zipRight(Deferred.await(gate), completed())
          );
          const pool = "builds";
          for (let index = 0; index < 4; index += 1) {
            yield* queue.submit({ handler, pool });
          }
          const limited = yield* queue.pools;
          yield* queue.configurePool({ limit: 3, name: pool, state: "active" });
          const resized = yield* queue.pools;
          yield* queue.configurePool({ limit: 4, name: pool, state: "paused" });
          const paused = yield* queue.pools;
          const invalid = yield* Effect.flip(
            queue.configurePool({ limit: 0, name: pool, state: "active" })
          );
          return { invalid, limited, paused, resized };
        }),
      { pools: [{ limit: 1, name: "builds", state: "active" }] }
    );
    expect(result.limited).toEqual([
      { active: 1, limit: 1, name: "builds", state: "active", waiting: 3 },
    ]);
    expect(result.resized[0]).toMatchObject({ active: 3, waiting: 1 });
    expect(result.paused[0]).toMatchObject({ active: 3, waiting: 1 });
    expect(result.invalid._tag).toBe("InvalidPoolLimitError");
  });

  test("a failing run is retried as a new run after its backoff, while a bailed run is not retried", async () => {
    const result = await testQueue((queue) =>
      Effect.gen(function* () {
        let calls = 0;
        yield* queue.register("work", () =>
          Effect.suspend(() => {
            calls += 1;
            return calls < 3
              ? Effect.fail<Failure>({ code: "flaky", message: "try again" })
              : completed("ok");
          })
        );
        yield* queue.register("reject", () =>
          Effect.succeed(
            done({
              error: { code: "invalid", message: "bad input" },
              kind: "bailed",
            })
          )
        );
        const job = yield* queue.submit({
          handler,
          policy: {
            retry: {
              backoff: { initialMs: 1000, kind: "exponential" },
              maxAttempts: 3,
            },
          },
        });
        yield* flush;
        const afterFirst = yield* queue.listRuns({ jobId: job.id });
        yield* TestClock.adjust(999);
        const beforeBackoff = calls;
        yield* TestClock.adjust(1);
        yield* TestClock.adjust(2000);
        const settled = yield* awaitJob(queue, job.id);
        const runs = yield* queue.listRuns({ jobId: job.id });
        const bailed = yield* queue.submit({
          handler: { name: "reject" },
          policy: { retry: { maxAttempts: 5 } },
        });
        return {
          afterFirst,
          bailed: yield* awaitJob(queue, bailed.id),
          bailedRuns: yield* queue.listRuns({ jobId: bailed.id }),
          beforeBackoff,
          runs,
          settled,
        };
      })
    );
    expect(result.afterFirst.map((run) => run.state)).toMatchObject([
      { kind: "failed", retryable: true },
      { availableAt: 1000, kind: "queued" },
    ]);
    expect(result.beforeBackoff).toBe(1);
    expect(result.runs.map((run) => [run.attempt, run.state.kind])).toEqual([
      [1, "failed"],
      [2, "failed"],
      [3, "completed"],
    ]);
    expect(result.settled.state).toMatchObject({
      kind: "completed",
      output: "ok",
    });
    expect(result.bailed.state).toMatchObject({
      error: { code: "invalid" },
      kind: "failed",
    });
    expect(result.bailedRuns).toHaveLength(1);
  });

  test("a run that exceeds its timeout is interrupted, aborting its signal, and fails", async () => {
    const result = await testQueue((queue) =>
      Effect.gen(function* () {
        let signal: AbortSignal | undefined;
        yield* queue.register("work", (context) =>
          Effect.zipRight(
            Effect.sync(() => {
              ({ signal } = context);
            }),
            Effect.never
          )
        );
        const job = yield* queue.submit({
          handler,
          policy: { timeoutMs: 500 },
        });
        yield* TestClock.adjust(500);
        return {
          aborted: signal?.aborted,
          job: yield* awaitJob(queue, job.id),
        };
      })
    );
    expect(result.aborted).toBe(true);
    expect(result.job.state).toMatchObject({
      error: { code: "timeout" },
      kind: "failed",
    });
  });

  test("cancelling withdraws a queued run and interrupts a running one, aborting its signal", async () => {
    const result = await testQueue(
      (queue) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>();
          const started = yield* Deferred.make<AbortSignal>();
          yield* queue.register("work", (context: RunContext) =>
            context.job.input === "first"
              ? Effect.as(
                  Deferred.await(first),
                  done({ kind: "completed", output: null })
                )
              : Effect.zipRight(
                  Deferred.succeed(started, context.signal),
                  Effect.never
                )
          );
          yield* queue.submit({ handler, input: "first" });
          const second = yield* queue.submit({ handler, input: "second" });
          const third = yield* queue.submit({ handler, input: "third" });
          yield* queue.cancel(third.id, "not needed");
          yield* Deferred.succeed(first, undefined);
          const signal = yield* Deferred.await(started);
          const abortedBefore = signal.aborted;
          yield* queue.cancel(second.id, "stop");
          return {
            abortedAfter: signal.aborted,
            abortedBefore,
            second: yield* queue.getJob(second.id),
            secondRuns: yield* queue.listRuns({ jobId: second.id }),
            third: yield* queue.listRuns({ jobId: third.id }),
          };
        }),
      { defaultLimit: 1 }
    );
    expect(result.third.map((run) => run.state.kind)).toEqual(["cancelled"]);
    expect(result.abortedBefore).toBe(false);
    expect(result.abortedAfter).toBe(true);
    expect(result.second?.state).toMatchObject({
      kind: "cancelled",
      reason: "stop",
    });
    expect(result.secondRuns.map((run) => run.state.kind)).toEqual([
      "cancelled",
    ]);
  });

  test("draining waits for running work, interrupts what outlives the grace period, and starts nothing new", async () => {
    const result = await testQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register("work", (context) =>
          Effect.as(
            Effect.sleep(context.job.input === "slow" ? 10_000 : 100),
            done({ kind: "completed", output: null })
          )
        );
        const quick = yield* queue.submit({ handler, input: "quick" });
        const slow = yield* queue.submit({
          handler,
          input: "slow",
          policy: { retry: { maxAttempts: 2 } },
        });
        yield* flush;
        const draining = yield* Effect.fork(queue.drain(1000));
        yield* TestClock.adjust(1000);
        yield* Fiber.join(draining);
        const late = yield* queue.submit({ handler, input: "quick" });
        yield* TestClock.adjust(1000);
        const whileDrained = yield* queue.getJob(late.id);
        const slowRuns = yield* queue.listRuns({ jobId: slow.id });
        yield* queue.resume;
        yield* TestClock.adjust(100);
        return {
          late: yield* queue.getJob(late.id),
          quick: yield* queue.getJob(quick.id),
          slowRuns,
          whileDrained,
        };
      })
    );
    expect(result.quick?.state.kind).toBe("completed");
    expect(result.slowRuns.map((run) => run.state.kind)).toEqual([
      "interrupted",
      "queued",
    ]);
    expect(result.whileDrained?.state.kind).toBe("pending");
    expect(result.late?.state.kind).toBe("completed");
  });

  test("events stream the lifecycle of a job as past-tense facts", async () => {
    const types = await testQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register("work", () => completed("ok"));
        const collected = yield* Effect.fork(
          queue.events.pipe(Stream.take(5), Stream.runCollect)
        );
        yield* flush;
        yield* queue.submit({ handler });
        const events = yield* Fiber.join(collected);
        return Chunk.toArray(events).map((event) => event.type);
      })
    );
    expect(types).toEqual([
      "JobSubmitted",
      "RunQueued",
      "RunStarted",
      "RunCompleted",
      "JobSettled",
    ]);
  });
});
