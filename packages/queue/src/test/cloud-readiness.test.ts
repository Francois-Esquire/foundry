import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  TestClock,
  TestContext,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimRun,
  enqueueJob,
  Queue,
  recoverExpiredLeases,
  renewLease,
  settleRun,
} from "../index";
import { QueueStore, type QueueStoreService } from "../store/index";
import { makeMemoryQueueStore } from "../store/memory";
import { makeSqliteQueueStore } from "../store/sqlite";
import { closeDatabases, openDatabase } from "./helpers/sqlite";

afterEach(closeDatabases);

const inTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));

describe("Queue cloud-readiness fixes", () => {
  it.each(["memory", "sqlite"] as const)(
    "filters and orders runs via RunFilter bounds and lease_expires_at in %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? makeSqliteQueueStore({
              database: await openDatabase(),
              scope: `queue-filter-${kind}`,
            })
          : await Effect.runPromise(makeMemoryQueueStore);

      const res = await inTestClock(
        Effect.gen(function* () {
          yield* enqueueJob(store, {
            delayMs: 500,
            handler: { name: "h" },
            pool: "p1",
          });
          yield* enqueueJob(store, {
            delayMs: 100,
            handler: { name: "h" },
            pool: "p1",
          });
          yield* enqueueJob(store, {
            delayMs: 50,
            handler: { name: "h" },
            pool: "p2",
          });

          const dueP1 = yield* store.listRuns({
            availableBefore: 200,
            limit: 1,
            orderBy: "availableAt",
            pool: "p1",
            state: "queued",
          });
          yield* TestClock.adjust(Duration.millis(150));
          const claimed = yield* claimRun(store, {
            leaseTtlMs: 100,
            pool: "p1",
            scanLimit: 10,
          });
          expect(claimed).toBeDefined();
          if (!claimed) {
            return { dueP1, expired: [], renewed: undefined };
          }
          const renewed = yield* renewLease(
            store,
            claimed.run.id,
            claimed.lease,
            { leaseTtlMs: 300 }
          );
          yield* TestClock.adjust(Duration.millis(400));
          const expired = yield* recoverExpiredLeases(store, { limit: 10 });
          return { dueP1, expired, renewed };
        })
      );

      expect(res.dueP1).toHaveLength(1);
      expect(res.renewed?.expiresAt).toBe(450);
      expect(res.expired).toHaveLength(1);
    }
  );

  it("skips background watermark polling when store.capabilities.watermark is false", async () => {
    const inner = await Effect.runPromise(makeMemoryQueueStore);
    let watermarkCalls = 0;
    const noWatermarkStore: QueueStoreService = {
      ...inner,
      capabilities: { watermark: false },
      watermark: Effect.sync(() => {
        watermarkCalls += 1;
        return 0;
      }),
    };
    const layer = Queue.layer({ syncIntervalMs: 10 }).pipe(
      Layer.provide(Layer.succeed(QueueStore, noWatermarkStore))
    );
    await inTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Queue;
          yield* TestClock.adjust(Duration.millis(50));
        }).pipe(Effect.provide(layer))
      )
    );
    expect(watermarkCalls).toBe(0);
  });

  it("heartbeats leases in dispatcher and aborts handler signal if lease is lost", async () => {
    const store = await Effect.runPromise(makeMemoryQueueStore);
    const layer = Queue.layer({
      leaseHeartbeatMs: 50,
      leaseTtlMs: 120,
      syncIntervalMs: 0,
    }).pipe(Layer.provide(Layer.succeed(QueueStore, store)));

    const result = await inTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue;
          const started = yield* Deferred.make<void>();
          const aborted = yield* Deferred.make<boolean>();
          yield* queue.register("work", (ctx) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              ctx.signal.addEventListener("abort", () => {
                Effect.runFork(Deferred.succeed(aborted, true));
              });
              yield* Deferred.await(aborted);
              return { kind: "complete" as const, output: "aborted" };
            })
          );
          const job = yield* queue.submit({ handler: { name: "work" } });
          yield* Deferred.await(started);

          yield* TestClock.adjust(Duration.millis(150));
          const [running] = yield* store.listRuns({ jobId: job.id });
          const extendedExpiry =
            running?.state.kind === "running"
              ? running.state.lease.expiresAt
              : undefined;

          if (running?.state.kind === "running") {
            yield* settleRun(
              store,
              running.id,
              running.state.lease,
              Exit.succeed({ kind: "complete", output: "stolen" })
            );
          }
          yield* TestClock.adjust(Duration.millis(60));
          return {
            aborted: yield* Deferred.await(aborted),
            extendedExpiry,
          };
        }).pipe(Effect.provide(layer))
      )
    );

    expect(result.extendedExpiry).toBeGreaterThan(120);
    expect(result.aborted).toBe(true);
  });
});
