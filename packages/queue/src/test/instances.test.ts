import {
  Deferred,
  Effect,
  Fiber,
  Stream,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, test } from "vitest";
import type { QueueEvent, RunOutcome } from "../domain";
import type { QueueStoreService } from "../store/index";
import {
  awaitJob,
  flush,
  handler,
  sharedStore,
  testQueue,
  withQueue,
} from "./helpers/queue";

const SYNC_MS = 500;

const complete = (output: string): RunOutcome => ({ kind: "complete", output });

const inTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));

describe("Queue instances sharing a store", () => {
  test("a retiring queue starts nothing queued, finishes its running work, and a successor runs what it left", async () => {
    const store = await sharedStore();
    const result = await inTestClock(
      withQueue(store, { defaultLimit: Number.POSITIVE_INFINITY }, (old) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          yield* old.register("work", (context) =>
            context.job.input === "long"
              ? Effect.as(Deferred.await(gate), complete("old"))
              : Effect.succeed(complete("old"))
          );
          const running = yield* old.submit({ handler, input: "long" });
          const later = yield* old.submit({ delayMs: 1000, handler });
          yield* awaitJob(old, running.id, ["active"]);
          const released = yield* old.retire();
          yield* TestClock.adjust(1000);
          const leftQueued = yield* old.listRuns({ jobId: later.id });
          return yield* withQueue(store, {}, (successor) =>
            Effect.gen(function* () {
              const waiting = yield* Effect.fork(old.awaitJob(later.id));
              yield* successor.register("work", () =>
                Effect.succeed(complete("successor"))
              );
              yield* TestClock.adjust(SYNC_MS);
              const handedOn = yield* Fiber.join(waiting);
              yield* Deferred.succeed(gate, undefined);
              return {
                finished: yield* old.awaitJob(running.id),
                handedOn,
                leftQueued,
                released,
              };
            })
          );
        })
      )
    );
    expect(result.released).toEqual(result.leftQueued.map((run) => run.id));
    expect(result.leftQueued[0]?.state.kind).toBe("queued");
    expect(result.leftQueued[0]?.state).not.toHaveProperty("owner");
    expect(result.handedOn.state).toMatchObject({ output: "successor" });
    expect(result.finished.state).toMatchObject({ output: "old" });
  });

  test("refuses a removal whose runs another queue removed after it read them", async () => {
    const store = await sharedStore();
    const read = await Effect.runPromise(Deferred.make<void>());
    const removed = await Effect.runPromise(Deferred.make<void>());
    const stale: QueueStoreService = {
      ...store,
      listSuspensions: (filter) =>
        Effect.zipRight(
          Effect.zipRight(
            Deferred.succeed(read, undefined),
            Deferred.await(removed)
          ),
          store.listSuspensions(filter)
        ),
    };
    const result = await inTestClock(
      withQueue(store, {}, (first) =>
        withQueue(stale, {}, (second) =>
          Effect.gen(function* () {
            yield* first.register("work", () =>
              Effect.succeed(complete("done"))
            );
            const job = yield* first.submit({ handler });
            yield* awaitJob(first, job.id);
            const late = yield* Effect.fork(
              Effect.either(second.removeJob(job.id))
            );
            yield* Deferred.await(read);
            yield* first.removeJob(job.id);
            yield* Deferred.succeed(removed, undefined);
            const outcome = yield* Fiber.join(late);
            return outcome._tag === "Left" ? outcome.left._tag : "removed";
          })
        )
      )
    );
    expect(result).toBe("JobNotFoundError");
  });

  test("retry and resumed runs are left unowned for any live queue to pick up", async () => {
    const runs = await testQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register("work", (context) => {
          if (context.job.input === "flaky") {
            return Effect.fail({ message: "boom", name: "Error" });
          }
          return Effect.succeed<RunOutcome>(
            context.resolutions.has("go")
              ? complete("resumed")
              : {
                  kind: "suspended",
                  suspension: {
                    key: "go",
                    kind: "human",
                    reason: "",
                    request: null,
                  },
                }
          );
        });
        const flaky = yield* queue.submit({
          handler,
          input: "flaky",
          policy: {
            retry: {
              backoff: { delayMs: 60_000, kind: "fixed" },
              maxAttempts: 2,
            },
          },
        });
        const asking = yield* queue.submit({ handler });
        yield* awaitJob(queue, asking.id, ["suspended"]);
        yield* queue.pause;
        const [suspension] = yield* queue.listSuspensions({ state: "pending" });
        if (suspension === undefined) {
          return yield* Effect.dieMessage("no pending suspension");
        }
        yield* queue.resolveSuspension(suspension.id, true);
        return [
          ...(yield* queue.listRuns({ jobId: flaky.id })),
          ...(yield* queue.listRuns({ jobId: asking.id })),
        ].filter((run) => run.state.kind === "queued");
      })
    );
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.state).not.toHaveProperty("owner");
    }
  });

  test("cancelling from another queue interrupts the running fiber here and aborts its signal", async () => {
    const store = await sharedStore();
    const result = await inTestClock(
      withQueue(store, {}, (runner) =>
        Effect.gen(function* () {
          const aborted = yield* Deferred.make<void>();
          yield* runner.register("work", (context) => {
            context.signal.addEventListener("abort", () =>
              Deferred.unsafeDone(aborted, Effect.void)
            );
            return Effect.never;
          });
          const job = yield* runner.submit({ handler });
          yield* awaitJob(runner, job.id, ["active"]);
          yield* withQueue(store, {}, (other) => other.cancel(job.id, "stop"));
          yield* TestClock.adjust(SYNC_MS);
          yield* Deferred.await(aborted);
          return {
            job: yield* runner.awaitJob(job.id),
            pools: yield* runner.pools,
          };
        })
      )
    );
    expect(result.job.state).toMatchObject({
      kind: "cancelled",
      reason: "stop",
    });
    expect(result.pools.every((pool) => pool.active === 0)).toBe(true);
  });

  test("awaiting a missing job fails, and a job removed by another queue while awaited fails as removed", async () => {
    const store = await sharedStore();
    const result = await inTestClock(
      withQueue(store, {}, (owner) =>
        Effect.gen(function* () {
          const events = yield* owner.subscribe;
          const gate = yield* Deferred.make<void>();
          yield* owner.register("work", () =>
            Effect.as(Deferred.await(gate), complete("done"))
          );
          const job = yield* owner.submit({ handler });
          yield* awaitJob(owner, job.id, ["active"]);
          return yield* withQueue(store, {}, (watcher) =>
            Effect.gen(function* () {
              const missing = yield* Effect.flip(watcher.awaitJob("jb-none"));
              const waiting = yield* Effect.fork(
                Effect.flip(watcher.awaitJob(job.id))
              );
              yield* flush;
              yield* Deferred.succeed(gate, undefined);
              yield* owner.awaitJob(job.id);
              yield* owner.removeJob(job.id);
              yield* TestClock.adjust(SYNC_MS);
              const removed = yield* Fiber.join(waiting);
              const seen = yield* Stream.runCollect(
                Stream.take(
                  Stream.filter(
                    events,
                    (
                      event
                    ): event is Extract<QueueEvent, { type: "job.removed" }> =>
                      event.type === "job.removed"
                  ),
                  1
                )
              );
              return {
                missing,
                removal: [...seen][0],
                removed,
                runs: yield* owner.listRuns({ jobId: job.id }),
              };
            })
          );
        })
      )
    );
    expect(result.missing._tag).toBe("JobNotFoundError");
    expect(result.removed._tag).toBe("JobRemovedError");
    expect(result.removal?.job.state.kind).toBe("complete");
    expect(result.removal?.runIds).toHaveLength(1);
    expect(result.runs).toEqual([]);
  });

  test("two queues in one process keep their own leases, and a closed queue's running work is recovered by the next", async () => {
    const store = await sharedStore();
    const result = await inTestClock(
      Effect.gen(function* () {
        const held = yield* withQueue(store, {}, (first) =>
          Effect.gen(function* () {
            yield* first.register("work", () => Effect.never);
            const job = yield* first.submit({ handler });
            yield* awaitJob(first, job.id, ["active"]);
            const whileOpen = yield* withQueue(store, {}, (second) =>
              second.recover()
            );
            return { job, whileOpen };
          })
        );
        const afterClose = yield* withQueue(store, {}, (next) =>
          next.recover()
        );
        return { ...held, afterClose };
      })
    );
    expect(result.whileOpen.interrupted).toEqual([]);
    expect(result.afterClose.interrupted).toHaveLength(1);
  });
});
