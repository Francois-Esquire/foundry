import { eq } from "drizzle-orm";
import { Deferred, Effect, Exit, Fiber, TestClock, TestContext } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import { createQueueClient } from "../client";
import type { RunOutcome } from "../domain";
import {
  cancelJob,
  claimRun,
  enqueueJob,
  recoverExpiredLeases,
  saveRunCheckpoint,
  settleRun,
} from "../stateless";
import { makeMemoryQueueStore } from "../store/memory";
import { makeSqliteQueueStore } from "../store/sqlite";
import { queueRuns } from "../store/tables";
import {
  awaitJob,
  flush,
  handler,
  sharedStore,
  withQueue,
} from "./helpers/queue";
import { closeDatabases, openDatabase } from "./helpers/sqlite";

afterEach(closeDatabases);

const inTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));

describe("TTL lease expiry recovery", () => {
  test("leaseTtlMs sets and refreshes Lease.expiresAt, and recover interrupts expired leases without OS PID checks", async () => {
    const store = await sharedStore();
    const foreign = { pid: 999_999, started: "worker-a" } as const;

    const result = await inTestClock(
      Effect.gen(function* () {
        const checkpointed = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const initialExpires = yield* withQueue(
          store,
          { identity: foreign, leaseTtlMs: 5000 },
          (workerA) =>
            Effect.gen(function* () {
              yield* workerA.register("work", (context) =>
                Effect.gen(function* () {
                  yield* TestClock.adjust(2000);
                  yield* context.saveCheckpoint({ step: 1 });
                  yield* Deferred.succeed(checkpointed, undefined);
                  yield* Deferred.await(releaseFirst);
                  return {
                    kind: "complete",
                    output: "late",
                  } satisfies RunOutcome;
                })
              );
              const job = yield* workerA.submit({
                handler,
                policy: { retry: { maxAttempts: 2 } },
              });
              yield* awaitJob(workerA, job.id, ["active"]);
              const [startedRun] = yield* store.listRuns({ jobId: job.id });
              const startExp =
                startedRun?.state.kind === "running"
                  ? startedRun.state.lease.expiresAt
                  : undefined;

              yield* Deferred.await(checkpointed);
              const [refreshedRun] = yield* store.listRuns({ jobId: job.id });
              const refreshedExp =
                refreshedRun?.state.kind === "running"
                  ? refreshedRun.state.lease.expiresAt
                  : undefined;

              const beforeExpiry = yield* withQueue(store, {}, (workerB) =>
                workerB.recover()
              );

              yield* TestClock.adjust(5000);
              const afterExpiry = yield* withQueue(store, {}, (workerB) =>
                workerB.recover()
              );
              const runs = yield* store.listRuns({ jobId: job.id });
              yield* Deferred.succeed(releaseFirst, undefined);
              return {
                afterExpiry,
                beforeExpiry,
                jobId: job.id,
                refreshedExp,
                runs,
                startExp,
              };
            })
        );

        return initialExpires;
      })
    );

    expect(result.startExp).toBe(5000);
    expect(result.refreshedExp).toBe(7000);
    expect(result.beforeExpiry.interrupted).toEqual([]);
    expect(result.afterExpiry.interrupted).toHaveLength(1);
    expect(result.runs.map((run) => run.state.kind)).toEqual([
      "interrupted",
      "queued",
    ]);
    if (result.runs[0]?.state.kind === "interrupted") {
      expect(result.runs[0].state.reason).toBe("lease expired");
    }
  });

  test("recover frees local capacity slot and interrupts local fiber on expired lease even with syncIntervalMs: 0", async () => {
    const store = await sharedStore();
    const result = await inTestClock(
      withQueue(
        store,
        { defaultLimit: 1, leaseTtlMs: 10, syncIntervalMs: 0 },
        (queue) =>
          Effect.gen(function* () {
            yield* queue.register("hang", () => Effect.never);
            yield* queue.register("fast", () =>
              Effect.succeed({
                kind: "complete",
                output: "ok",
              } satisfies RunOutcome)
            );
            const stuck = yield* queue.submit({ handler: { name: "hang" } });
            yield* awaitJob(queue, stuck.id, ["active"]);
            yield* TestClock.adjust(20);
            const summary = yield* queue.recover();
            const pools = yield* queue.pools;
            const next = yield* queue.submit({ handler: { name: "fast" } });
            const done = yield* queue.awaitJob(next.id);
            return { done, pools, summary };
          })
      )
    );

    expect(result.summary.interrupted).toHaveLength(1);
    expect(
      result.pools.find((pool) => pool.name === "default")?.active ?? 0
    ).toBe(0);
    expect(result.done.state).toMatchObject({ kind: "complete", output: "ok" });
  });
});

describe("Stateless queue primitives", () => {
  test("enqueueJob -> claimRun -> saveRunCheckpoint -> settleRun operates with zero background fibers", async () => {
    const result = await inTestClock(
      Effect.gen(function* () {
        const store = yield* makeMemoryQueueStore;
        const job = yield* enqueueJob(store, {
          handler,
          input: { value: 1 },
          policy: { idempotencyKey: "k-1", retry: { maxAttempts: 2 } },
          pool: "fast",
        });
        const duplicate = yield* enqueueJob(store, {
          handler,
          input: { value: 2 },
          policy: { idempotencyKey: "k-1" },
          pool: "fast",
        });
        const delayed = yield* enqueueJob(store, {
          delayMs: 1000,
          handler: { name: "other" },
          pool: "slow",
        });

        const [queued] = yield* store.listRuns({ jobId: job.id });
        const filteredOut = yield* claimRun(store, {
          handlerNames: ["other"],
          pool: "fast",
        });
        const claimed = yield* claimRun(store, {
          handlerNames: ["work"],
          leaseTtlMs: 3000,
          pool: "fast",
        });
        if (claimed === undefined) {
          return yield* Effect.dieMessage("expected claimed run");
        }

        yield* TestClock.adjust(1000);
        const saved = yield* saveRunCheckpoint(
          store,
          claimed.run.id,
          claimed.lease,
          { cursor: 1 },
          { leaseTtlMs: 3000 }
        );
        const afterCheckpoint = yield* store.getRun(claimed.run.id);

        const settled = yield* settleRun(
          store,
          claimed.run.id,
          claimed.lease,
          Exit.succeed({ kind: "complete", output: "ok" })
        );
        const finalJob = yield* store.getJob(job.id);

        const lateCheckpoint = yield* saveRunCheckpoint(
          store,
          claimed.run.id,
          claimed.lease,
          { cursor: 2 }
        );

        const delayedClaim = yield* claimRun(store, {
          leaseTtlMs: 1000,
          pool: "slow",
        });
        if (delayedClaim === undefined) {
          return yield* Effect.dieMessage("expected delayed run");
        }
        yield* TestClock.adjust(1000);
        const expired = yield* recoverExpiredLeases(store);

        const toCancel = yield* enqueueJob(store, { handler });
        yield* cancelJob(store, toCancel.id, "nope");
        const cancelledJob = yield* store.getJob(toCancel.id);

        return {
          afterCheckpoint,
          cancelledJob,
          claimed,
          delayed,
          duplicate,
          expired,
          filteredOut,
          finalJob,
          job,
          lateCheckpoint,
          queued,
          saved,
          settled,
        };
      })
    );

    expect(result.duplicate.id).toBe(result.job.id);
    expect(result.queued?.state.kind).toBe("queued");
    expect(result.queued?.state).not.toHaveProperty("owner");
    expect(result.filteredOut).toBeUndefined();
    expect(result.claimed.lease.expiresAt).toBe(3000);
    expect(result.saved).toBe(true);
    expect(result.afterCheckpoint?.checkpoint).toEqual({ cursor: 1 });
    expect(
      result.afterCheckpoint?.state.kind === "running"
        ? result.afterCheckpoint.state.lease.expiresAt
        : undefined
    ).toBe(4000);
    expect(result.settled).toBe(true);
    expect(result.finalJob?.state).toMatchObject({
      kind: "complete",
      output: "ok",
    });
    expect(result.lateCheckpoint).toBe(false);
    expect(result.expired).toHaveLength(1);
    expect(result.cancelledJob?.state).toMatchObject({
      kind: "cancelled",
      reason: "nope",
    });
  });

  test("settleRun schedules retries on failure according to the job retry policy", async () => {
    const result = await inTestClock(
      Effect.gen(function* () {
        const store = yield* makeMemoryQueueStore;
        const job = yield* enqueueJob(store, {
          handler,
          policy: {
            retry: {
              backoff: { delayMs: 500, kind: "fixed" },
              maxAttempts: 2,
            },
          },
        });
        const first = yield* claimRun(store);
        if (first === undefined) {
          return yield* Effect.dieMessage("expected first claim");
        }
        yield* settleRun(
          store,
          first.run.id,
          first.lease,
          Exit.fail({ message: "transient", name: "Error" })
        );
        const beforeDue = yield* claimRun(store);
        yield* TestClock.adjust(500);
        const second = yield* claimRun(store);
        if (second === undefined) {
          return yield* Effect.dieMessage("expected second claim");
        }
        yield* settleRun(
          store,
          second.run.id,
          second.lease,
          Exit.succeed({ kind: "complete", output: "recovered" })
        );
        return {
          beforeDue,
          finalJob: yield* store.getJob(job.id),
          runs: yield* store.listRuns({ jobId: job.id }),
        };
      })
    );

    expect(result.beforeDue).toBeUndefined();
    expect(result.finalJob?.state).toMatchObject({
      kind: "complete",
      output: "recovered",
    });
    expect(result.runs.map((run) => [run.attempt, run.state.kind])).toEqual([
      [1, "failed"],
      [2, "complete"],
    ]);
  });

  test("claimRun respects pool limits, paused pools, and foreign owners; settleRun interrupts interrupt-only exits", async () => {
    const result = await inTestClock(
      Effect.gen(function* () {
        const store = yield* makeMemoryQueueStore;
        yield* store.commit({
          pools: [
            { limit: 1, name: "limited", state: "active" },
            { limit: 2, name: "paused", state: "paused" },
          ],
        });
        yield* enqueueJob(store, { handler, pool: "limited" });
        yield* enqueueJob(store, { handler, pool: "limited" });
        yield* enqueueJob(store, { handler, pool: "paused" });
        yield* enqueueJob(
          store,
          { handler, pool: "limited" },
          { owner: { instanceId: "other-queue", pid: 1, started: "other" } }
        );

        const first = yield* claimRun(store, { pool: "limited" });
        const secondBlockedByLimit = yield* claimRun(store, {
          pool: "limited",
        });
        const pausedClaim = yield* claimRun(store, { pool: "paused" });
        if (first === undefined) {
          return yield* Effect.dieMessage("expected first claim");
        }
        const interrupted = yield* settleRun(
          store,
          first.run.id,
          first.lease,
          Exit.interrupt(Fiber.id(yield* Effect.fork(Effect.void)))
        );
        const afterInterrupt = yield* store.getRun(first.run.id);
        const second = yield* claimRun(store, { pool: "limited" });
        if (second === undefined) {
          return yield* Effect.dieMessage("expected second claim");
        }
        yield* settleRun(
          store,
          second.run.id,
          second.lease,
          Exit.succeed({ kind: "complete", output: "ok" })
        );
        const ownedBlocked = yield* claimRun(store, { pool: "limited" });

        return {
          afterInterrupt,
          interrupted,
          ownedBlocked,
          pausedClaim,
          secondBlockedByLimit,
        };
      })
    );

    expect(result.secondBlockedByLimit).toBeUndefined();
    expect(result.pausedClaim).toBeUndefined();
    expect(result.interrupted).toBe(true);
    expect(result.afterInterrupt?.state.kind).toBe("interrupted");
    expect(result.ownedBlocked).toBeUndefined();
  });
});

describe("Queue.drainUntilIdle", () => {
  test("waits until queued, active, retried, and dynamically spawned jobs all settle", async () => {
    const completed: string[] = [];
    const client = createQueueClient({ defaultLimit: 1 });
    try {
      let flakyAttempts = 0;
      await client.register("parent", async () => {
        await client.submit({
          handler: { name: "child" },
          input: "from-parent",
        });
        return { kind: "complete", output: "parent-done" };
      });
      await client.register("child", async (context) => {
        if (context.job.input === "flaky" && flakyAttempts === 0) {
          flakyAttempts += 1;
          throw new Error("retry once");
        }
        completed.push(String(context.job.input));
        return { kind: "complete", output: "child-done" };
      });

      const job = await client.submit({
        handler: { name: "parent" },
      });
      const flaky = await client.submit({
        handler: { name: "child" },
        input: "flaky",
        policy: {
          retry: { backoff: { delayMs: 20, kind: "fixed" }, maxAttempts: 2 },
        },
      });

      await client.drainUntilIdle();

      expect((await client.getJob(job.id))?.state.kind).toBe("complete");
      expect((await client.getJob(flaky.id))?.state.kind).toBe("complete");
      expect(completed.sort()).toEqual(["flaky", "from-parent"]);
    } finally {
      await client.dispose();
    }
  });

  test("honors graceMs when a job stays active past the deadline", async () => {
    const store = await sharedStore();
    const state = await inTestClock(
      withQueue(store, {}, (queue) =>
        Effect.gen(function* () {
          yield* queue.register("work", () => Effect.never);
          const job = yield* queue.submit({ handler });
          yield* awaitJob(queue, job.id, ["active"]);
          const draining = yield* Effect.fork(queue.drainUntilIdle(100));
          yield* flush;
          yield* TestClock.adjust(100);
          yield* Fiber.join(draining);
          return (yield* queue.getJob(job.id))?.state.kind;
        })
      )
    );
    expect(state).toBe("failed");
  });

  test("returns immediately when paused or only unstartable runs remain, and graceMs timeout does not pause admission", async () => {
    const store = await sharedStore();
    const afterGrace = await inTestClock(
      withQueue(store, {}, (queue) =>
        Effect.gen(function* () {
          yield* queue.register("hang", () => Effect.never);
          yield* queue.register("ok", () =>
            Effect.succeed({
              kind: "complete",
              output: "ran",
            } satisfies RunOutcome)
          );
          yield* enqueueJob(store, { handler: { name: "unregistered" } });
          yield* queue.drainUntilIdle();

          const stuck = yield* queue.submit({ handler: { name: "hang" } });
          yield* awaitJob(queue, stuck.id, ["active"]);
          const draining = yield* Effect.fork(queue.drainUntilIdle(50));
          yield* flush;
          yield* TestClock.adjust(50);
          yield* Fiber.join(draining);

          const next = yield* queue.submit({ handler: { name: "ok" } });
          return yield* queue.awaitJob(next.id);
        })
      )
    );
    expect(afterGrace.state).toMatchObject({ kind: "complete", output: "ran" });
  });
});

describe("SqliteQueueStore indexes and watermark toggle", () => {
  test("watermark: false skips queue_watermarks writes while populating availableAt and pool columns", async () => {
    const database = await openDatabase();
    const store = makeSqliteQueueStore({
      database,
      scope: "stateless",
      watermark: false,
    });

    const job = await Effect.runPromise(
      enqueueJob(store, {
        delayMs: 250,
        handler,
        pool: "gpu",
      })
    );

    const mark = await Effect.runPromise(store.watermark);
    const rows = await database
      .select({
        availableAt: queueRuns.availableAt,
        pool: queueRuns.pool,
        state: queueRuns.state,
      })
      .from(queueRuns)
      .where(eq(queueRuns.jobId, job.id));

    expect(mark).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pool).toBe("gpu");
    expect(rows[0]?.state).toBe("queued");
    expect(typeof rows[0]?.availableAt).toBe("number");

    const claimed = await Effect.runPromise(claimRun(store, { pool: "gpu" }));
    expect(claimed).toBeUndefined();

    const nowJob = await Effect.runPromise(
      enqueueJob(store, { handler, pool: "gpu" })
    );
    const active = await Effect.runPromise(claimRun(store, { pool: "gpu" }));
    expect(active?.job.id).toBe(nowJob.id);

    const activeRows = await database
      .select({
        availableAt: queueRuns.availableAt,
        pool: queueRuns.pool,
        state: queueRuns.state,
      })
      .from(queueRuns)
      .where(eq(queueRuns.jobId, nowJob.id));

    expect(activeRows[0]).toEqual({
      availableAt: null,
      pool: "gpu",
      state: "running",
    });
    expect(await Effect.runPromise(store.watermark)).toBe(0);
  });
});
