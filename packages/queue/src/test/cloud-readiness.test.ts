import { Deferred, Effect, Exit, Layer, TestClock, TestContext } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelSuspension,
  claimRun,
  enqueueJob,
  nextWakeAt,
  Queue,
  recoverExpiredLeases,
  removeJob,
  renewLease,
  resolveSuspension,
  settleRun,
  yieldRun,
} from "../index";
import { QueueStore } from "../store/index";
import { makeMemoryQueueStore } from "../store/memory";
import { makeSqliteQueueStore } from "../store/sqlite";
import { closeDatabases, openDatabase } from "./helpers/sqlite";

afterEach(closeDatabases);

describe("Queue cloud-native stateless seams", () => {
  it.each(["memory", "sqlite"] as const)(
    "supports suspend, resolveSuspension, claimRun with resolutions, yieldRun, renewLease, lease expiry, nextWakeAt, and removeJob on %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? makeSqliteQueueStore({
              database: await openDatabase(),
              scope: "queue-cloud",
              watermark: false,
            })
          : await Effect.runPromise(makeMemoryQueueStore);

      if (kind === "sqlite") {
        expect(store.capabilities?.watermark).toBe(false);
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const job = yield* enqueueJob(store, {
            handler: { name: "agent" },
            input: { step: 1 },
          });
          const firstClaim = yield* claimRun(store, {
            handlerNames: ["agent"],
            leaseTtlMs: 5000,
          });
          if (!firstClaim) {
            throw new Error("expected first claim");
          }

          const renewed = yield* renewLease(
            store,
            firstClaim.run.id,
            firstClaim.lease,
            { leaseTtlMs: 10_000 }
          );
          expect(renewed?.expiresAt).toBeDefined();

          const yielded = yield* yieldRun(
            store,
            firstClaim.run.id,
            firstClaim.lease,
            { checkpoint: { progress: 1 }, delayMs: 0 }
          );
          expect(yielded).toBe(true);

          const secondClaim = yield* claimRun(store, {
            handlerNames: ["agent"],
            leaseTtlMs: 5000,
          });
          if (!secondClaim) {
            throw new Error("expected second claim after yield");
          }
          expect(secondClaim.run.attempt).toBe(1);
          expect(secondClaim.run.checkpoint).toEqual({ progress: 1 });

          yield* settleRun(
            store,
            secondClaim.run.id,
            secondClaim.lease,
            Exit.succeed({
              kind: "suspended",
              suspension: {
                key: "approval-1",
                kind: "approval",
                reason: "need approval",
                request: { ok: true },
              },
            })
          );
          const pending = yield* store.listSuspensions({
            runId: secondClaim.run.id,
            state: "pending",
          });
          const [suspension] = pending;
          if (!suspension) {
            throw new Error("expected pending suspension");
          }
          yield* resolveSuspension(store, suspension.id, { approved: true });

          const thirdClaim = yield* claimRun(store, {
            handlerNames: ["agent"],
            leaseTtlMs: 1000,
          });
          if (!thirdClaim) {
            throw new Error("expected third claim after resolution");
          }
          expect(thirdClaim.resolutions.get("approval-1")).toEqual({
            approved: true,
          });

          const wake = yield* nextWakeAt(store);
          expect(wake).toBe(thirdClaim.lease.expiresAt);

          const recovered = yield* recoverExpiredLeases(store, {
            now: (thirdClaim.lease.expiresAt ?? Date.now()) + 10,
          });
          expect(recovered).toEqual([thirdClaim.run.id]);

          const finalJob = yield* store.getJob(job.id);
          if (finalJob?.state.kind === "failed") {
            yield* removeJob(store, job.id);
          }
          const gone = yield* store.getJob(job.id);

          const job2 = yield* enqueueJob(store, {
            handler: { name: "agent" },
            input: null,
          });
          const c2 = yield* claimRun(store, { handlerNames: ["agent"] });
          if (!c2) {
            throw new Error("expected c2");
          }
          yield* settleRun(
            store,
            c2.run.id,
            c2.lease,
            Exit.succeed({
              kind: "suspended",
              suspension: {
                key: "k2",
                kind: "approval",
                reason: "wait",
                request: null,
              },
            })
          );
          const [s2] = yield* store.listSuspensions({
            runId: c2.run.id,
            state: "pending",
          });
          if (!s2) {
            throw new Error("expected s2");
          }
          const cancelled = yield* cancelSuspension(store, s2.id, "aborted");
          const j2 = yield* store.getJob(job2.id);

          return {
            cancelledState: cancelled.state.kind,
            gone,
            j2State: j2?.state.kind,
          };
        })
      );

      expect(result).toEqual({
        cancelledState: "cancelled",
        gone: undefined,
        j2State: "cancelled",
      });
    }
  );

  it("supports ownership: 'shared' and skips watchStore when watermark capability is false", async () => {
    const store = await Effect.runPromise(makeMemoryQueueStore);
    let watermarkReads = 0;
    const noWatermarkStore = {
      ...store,
      capabilities: { watermark: false },
      watermark: Effect.sync(() => {
        watermarkReads += 1;
        return 0;
      }),
    };
    const runs = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue;
          yield* queue.register("echo", (ctx) =>
            Effect.succeed({ kind: "complete", output: ctx.job.input })
          );
          const submitted = yield* queue.submit({
            delayMs: 60_000,
            handler: { name: "echo" },
            input: "shared",
          });
          return yield* queue.listRuns({ jobId: submitted.id });
        }).pipe(
          Effect.provide(
            Queue.layer({ ownership: "shared" }).pipe(
              Layer.provide(Layer.succeed(QueueStore, noWatermarkStore))
            )
          )
        )
      )
    );
    expect(watermarkReads).toBe(0);
    expect(runs).toHaveLength(1);
    expect(
      runs[0]?.state.kind === "queued" ? runs[0].state.owner : "unexpected"
    ).toBeUndefined();
  });

  it.each(["memory", "sqlite"] as const)(
    "claimRun skips 64 ineligible prefix runs without head-of-line starvation on %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? makeSqliteQueueStore({
              database: await openDatabase(),
              scope: "queue-hol",
              watermark: false,
            })
          : await Effect.runPromise(makeMemoryQueueStore);

      const claimed = await Effect.runPromise(
        Effect.gen(function* () {
          for (let index = 0; index < 64; index += 1) {
            yield* enqueueJob(store, {
              handler: { name: "other" },
              input: index,
            });
          }
          const target = yield* enqueueJob(store, {
            handler: { name: "mine" },
            input: "target",
          });
          const result = yield* claimRun(store, {
            handlerNames: ["mine"],
          });
          return { result, target };
        })
      );

      expect(claimed.result?.job.id).toBe(claimed.target.id);
      expect(claimed.result?.job.handler.name).toBe("mine");
    }
  );

  it.each(["memory", "sqlite"] as const)(
    "nextWakeAt excludes queued runs in paused pools on %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? makeSqliteQueueStore({
              database: await openDatabase(),
              scope: "queue-paused-wake",
              watermark: false,
            })
          : await Effect.runPromise(makeMemoryQueueStore);

      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          yield* store.commit({
            pools: [{ limit: 4, name: "paused-pool", state: "paused" }],
          });
          yield* enqueueJob(store, {
            delayMs: 0,
            handler: { name: "work" },
            pool: "paused-pool",
          });

          const onlyPaused = yield* nextWakeAt(store);
          const pausedFiltered = yield* nextWakeAt(store, {
            pool: "paused-pool",
          });

          const activeJob = yield* enqueueJob(store, {
            delayMs: 5000,
            handler: { name: "work" },
            pool: "active-pool",
          });
          const [activeRun] = yield* store.listRuns({ jobId: activeJob.id });
          const expectedAt =
            activeRun?.state.kind === "queued"
              ? activeRun.state.availableAt
              : undefined;
          const withActive = yield* nextWakeAt(store);

          return { expectedAt, onlyPaused, pausedFiltered, withActive };
        })
      );

      expect(outcome.onlyPaused).toBeUndefined();
      expect(outcome.pausedFiltered).toBeUndefined();
      expect(outcome.withActive).toBe(outcome.expectedAt);
    }
  );

  it.each(["memory", "sqlite"] as const)(
    "listRuns with orderBy: 'leaseExpiresAt' excludes runs without expiresAt and sorts ascending on %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? makeSqliteQueueStore({
              database: await openDatabase(),
              scope: "queue-lease-order",
              watermark: false,
            })
          : await Effect.runPromise(makeMemoryQueueStore);

      const owner = { instanceId: "w-1", pid: 1, started: "now" } as const;
      const runs = await Effect.runPromise(
        Effect.gen(function* () {
          yield* store.commit({
            runs: [
              {
                attempt: 1,
                id: "rn-no-exp",
                jobId: "jb-1",
                pool: "default",
                revision: 1,
                state: {
                  kind: "running",
                  lease: { claimedAt: 100, owner },
                },
              },
              {
                attempt: 1,
                id: "rn-later",
                jobId: "jb-2",
                pool: "default",
                revision: 1,
                state: {
                  kind: "running",
                  lease: { claimedAt: 100, expiresAt: 2000, owner },
                },
              },
              {
                attempt: 1,
                id: "rn-sooner",
                jobId: "jb-3",
                pool: "default",
                revision: 1,
                state: {
                  kind: "running",
                  lease: { claimedAt: 100, expiresAt: 1000, owner },
                },
              },
            ],
          });
          return yield* store.listRuns({
            orderBy: "leaseExpiresAt",
            state: "running",
          });
        })
      );

      expect(runs.map((run) => run.id)).toEqual(["rn-sooner", "rn-later"]);
    }
  );

  it.each(["memory", "sqlite"] as const)(
    "listRuns with orderBy: 'availableAt' excludes non-queued runs and sorts ascending on %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? makeSqliteQueueStore({
              database: await openDatabase(),
              scope: "queue-available-order",
              watermark: false,
            })
          : await Effect.runPromise(makeMemoryQueueStore);

      const owner = { instanceId: "w-1", pid: 1, started: "now" } as const;
      const runs = await Effect.runPromise(
        Effect.gen(function* () {
          yield* store.commit({
            runs: [
              {
                attempt: 1,
                id: "rn-running",
                jobId: "jb-1",
                pool: "default",
                revision: 1,
                state: {
                  kind: "running",
                  lease: { claimedAt: 100, expiresAt: 5000, owner },
                },
              },
              {
                attempt: 1,
                id: "rn-later",
                jobId: "jb-2",
                pool: "default",
                revision: 1,
                state: { availableAt: 2000, kind: "queued", queuedAt: 100 },
              },
              {
                attempt: 1,
                id: "rn-sooner",
                jobId: "jb-3",
                pool: "default",
                revision: 1,
                state: { availableAt: 1000, kind: "queued", queuedAt: 100 },
              },
            ],
          });
          return yield* store.listRuns({ orderBy: "availableAt" });
        })
      );

      expect(runs.map((run) => run.id)).toEqual(["rn-sooner", "rn-later"]);
    }
  );

  it.each(["memory", "sqlite"] as const)(
    "nextWakeAt excludes due queued runs in pools at capacity and returns the running lease expiry on %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? makeSqliteQueueStore({
              database: await openDatabase(),
              scope: "queue-capacity-wake",
              watermark: false,
            })
          : await Effect.runPromise(makeMemoryQueueStore);

      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.adjust(10_000);
          yield* store.commit({
            pools: [{ limit: 1, name: "serial", state: "active" }],
          });
          yield* enqueueJob(store, {
            delayMs: 0,
            handler: { name: "work" },
            pool: "serial",
          });
          yield* enqueueJob(store, {
            delayMs: 0,
            handler: { name: "work" },
            pool: "serial",
          });

          const claimed = yield* claimRun(store, {
            leaseTtlMs: 60_000,
            pool: "serial",
          });
          if (!claimed) {
            throw new Error("expected claim in serial pool");
          }

          const wakeAllAtCapacity = yield* nextWakeAt(store);
          const wakePoolAtCapacity = yield* nextWakeAt(store, {
            pool: "serial",
          });

          yield* enqueueJob(store, {
            delayMs: 5000,
            handler: { name: "work" },
            pool: "other",
          });
          const wakeWithOtherPool = yield* nextWakeAt(store);
          const wakeSerialStillBlocked = yield* nextWakeAt(store, {
            pool: "serial",
          });

          return {
            expectedLeaseExpiry: claimed.lease.expiresAt,
            wakeAllAtCapacity,
            wakePoolAtCapacity,
            wakeSerialStillBlocked,
            wakeWithOtherPool,
          };
        }).pipe(Effect.provide(TestContext.TestContext))
      );

      expect(outcome.expectedLeaseExpiry).toBe(70_000);
      expect(outcome.wakeAllAtCapacity).toBe(70_000);
      expect(outcome.wakePoolAtCapacity).toBe(70_000);
      expect(outcome.wakeWithOtherPool).toBe(15_000);
      expect(outcome.wakeSerialStillBlocked).toBe(70_000);
    }
  );

  it("dispatcher heartbeat renews small leaseTtlMs and aborts the handler signal when the lease is lost", async () => {
    const store = await Effect.runPromise(makeMemoryQueueStore);

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue;
          const started = yield* Deferred.make<void>();
          const aborted = yield* Deferred.make<unknown>();

          yield* queue.register("long", (ctx) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              const reason = yield* Effect.async<unknown>((resume) => {
                if (ctx.signal.aborted) {
                  resume(Effect.succeed(ctx.signal.reason));
                  return;
                }
                const onAbort = () => {
                  resume(Effect.succeed(ctx.signal.reason));
                };
                ctx.signal.addEventListener("abort", onAbort, { once: true });
                return Effect.sync(() => {
                  ctx.signal.removeEventListener("abort", onAbort);
                });
              });
              yield* Deferred.succeed(aborted, reason);
              return { kind: "complete", output: "aborted" };
            })
          );

          const job = yield* queue.submit({ handler: { name: "long" } });
          yield* Deferred.await(started);

          const [initialRun] = yield* store.listRuns({ jobId: job.id });
          const initialExpiry =
            initialRun?.state.kind === "running"
              ? initialRun.state.lease.expiresAt
              : undefined;

          // leaseTtlMs = 90 => default heartbeat interval = floor(90 / 3) = 30ms
          yield* TestClock.adjust(30);
          const [renewedRun] = yield* store.listRuns({ jobId: job.id });
          const renewedExpiry =
            renewedRun?.state.kind === "running"
              ? renewedRun.state.lease.expiresAt
              : undefined;

          if (renewedRun === undefined) {
            throw new Error("expected running run");
          }

          // Simulate lease stolen/lost externally by another worker
          yield* store.commit({
            runs: [
              {
                ...renewedRun,
                revision: renewedRun.revision + 1,
                state: {
                  kind: "running",
                  lease: {
                    claimedAt: 30,
                    expiresAt: 120,
                    owner: {
                      instanceId: "other-worker",
                      pid: 2,
                      started: "other",
                    },
                  },
                },
              },
            ],
          });

          // Next heartbeat tick sees renewLease return undefined and aborts signal
          yield* TestClock.adjust(30);
          const abortReason = yield* Deferred.await(aborted);
          return { abortReason, initialExpiry, renewedExpiry };
        }).pipe(
          Effect.provide(
            Queue.layer({ leaseTtlMs: 90, syncIntervalMs: 0 }).pipe(
              Layer.provide(Layer.succeed(QueueStore, store))
            )
          )
        )
      ).pipe(Effect.provide(TestContext.TestContext))
    );

    expect(outcome.initialExpiry).toBe(90);
    expect(outcome.renewedExpiry).toBe(120);
    expect(outcome.abortReason).toBeInstanceOf(Error);
  });
});
