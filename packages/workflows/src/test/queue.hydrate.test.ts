/**
 * Queue.hydrate — rebuild a DispatchedWorkflow from the persisted run row.
 *
 * This is the cornerstone of the JS-first surface: with hydrate in place, a
 * caller holding only a `runId` (e.g. an HTTP webhook handler resuming a
 * suspended run from days ago) can rebuild the in-memory handle and use
 * the sync accessors `output / results / error / snapshot` plus the
 * Promise methods `resume / cancel / result`.
 *
 * Hydration is passive — it does NOT re-enqueue the run for execution.
 * It just rebuilds the handle and seeds its snapshot from persisted state.
 */

import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { Queue } from "../queue";
import { Workflow } from "../workflow";
import { makeEchoSpec, makeSuspendingSpec } from "./fixtures/steps";
import { makeInMemoryStore } from "./helpers/store";

// ════════════════════════════════════════════════════════════════════════════
// 1. Basic hydration of a complete run
// ════════════════════════════════════════════════════════════════════════════

describe("Queue.hydrate — terminal run", () => {
  test("hydrates a completed run; sync accessors reflect persisted state", async () => {
    // First queue: dispatch and let it run to completion. Capture the
    // runId. Shut it down so the in-memory #all is gone.
    const store = makeInMemoryStore();
    const queueA = new Queue({ concurrency: 1, store });
    const runId = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create(
            makeEchoSpec("payload-A", "hydrate-complete")
          );
          const d = queueA.dispatch(wf);
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await queueA.drain();
    await queueA.shutdown();

    // Second queue over the same store: hydrate by runId, factory pulls
    // the input from the recoverable row and rebuilds the workflow.
    const queueB = new Queue({ concurrency: 1, store });
    const dispatched = await queueB.hydrate(runId, (recoverable) =>
      Workflow.create(
        makeEchoSpec(recoverable.input as string, "hydrate-complete")
      )
    );
    expect(dispatched).not.toBeNull();
    expect(dispatched?.id).toBe(runId);
    expect(dispatched?.status).toBe("complete");
    // Snapshot was seeded from the persisted blob — the step's terminal
    // output is reachable via the `results` accessor.
    expect(dispatched?.results["hydrate-complete"]).toBe("payload-A");
    await queueB.shutdown();
  });
});

describe("Queue.hydrate — passive cancellation", () => {
  test.each(["queued", "running"] as const)(
    "cancels a passively hydrated %s Run without corrupting drain accounting",
    async (status) => {
      const store = makeInMemoryStore();
      const row = await store.createRun({
        id: `rn-passive-${status}`,
        input: null,
        queueId: "main",
        step: "passive-hydrate",
      });
      if (status === "running") {
        await store.updateRun(row.id, { status: "running" });
      }
      const queue = new Queue({ concurrency: 1, store });
      const dispatched = await queue.hydrate(row.id, () =>
        Workflow.create({
          execute: async () => "must not execute",
          input: null,
          name: "passive-hydrate",
        })
      );
      if (!dispatched) {
        throw new Error("expected hydrated Run");
      }

      await store.cancelRun(row.id);
      await queue.applyAuthoritativeCancellation(row.id);

      await expect(dispatched.result()).resolves.toMatchObject({
        status: "cancelled",
      });
      await expect(
        Promise.race([
          queue.drain().then(() => "drained" as const),
          new Promise<"timed-out">((resolve) =>
            setTimeout(() => {
              resolve("timed-out");
            }, 100)
          ),
        ])
      ).resolves.toBe("drained");
      await queue.shutdown();
    }
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Hydration of a suspended run
// ════════════════════════════════════════════════════════════════════════════

describe("Queue.hydrate — suspended run", () => {
  test("hydrates a suspended run; suspension state is visible on the handle", async () => {
    const store = makeInMemoryStore();
    const queueA = new Queue({ concurrency: 1, store });
    const runId = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create(
            makeSuspendingSpec(
              {
                meta: { ticket: "TKT-001" },
                reason: "external-review",
                suspendName: "approval",
              },
              "hydrate-suspend"
            )
          );
          const d = queueA.dispatch(wf);
          while (d.status !== "suspended") {
            yield* Effect.sleep(10);
          }
          // Wait an extra reactive-write window so the suspension is
          // durable in the row before queueA goes away.
          yield* Effect.sleep(50);
          return d.id;
        })
      )
    );
    await queueA.shutdown();

    const queueB = new Queue({ concurrency: 1, store });
    const dispatched = await queueB.hydrate(runId, () =>
      Workflow.create(
        makeSuspendingSpec(
          { reason: "external-review", suspendName: "approval" },
          "hydrate-suspend"
        )
      )
    );
    expect(dispatched).not.toBeNull();
    expect(dispatched?.status).toBe("suspended");
    expect(dispatched?.snapshot.suspension?.name).toBe("approval");
    expect(dispatched?.snapshot.suspension?.reason).toBe("external-review");
    await queueB.shutdown();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Hydration of a failed run — error accessor
// ════════════════════════════════════════════════════════════════════════════

describe("Queue.hydrate — failed run", () => {
  test("hydrates a failed run; dispatched.error reflects persisted error shape", async () => {
    const store = makeInMemoryStore();
    const queueA = new Queue({ concurrency: 1, store });
    const runId = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create({
            execute: async () => {
              throw new RangeError("out-of-bounds");
            },
            input: undefined,
            name: "hydrate-failed",
          });
          const d = queueA.dispatch(wf);
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await queueA.drain();
    await queueA.shutdown();

    const queueB = new Queue({ concurrency: 1, store });
    const dispatched = await queueB.hydrate(runId, () =>
      Workflow.create({
        execute: async () => {
          throw new RangeError("out-of-bounds");
        },
        input: undefined,
        name: "hydrate-failed",
      })
    );
    expect(dispatched).not.toBeNull();
    expect(dispatched?.status).toBe("failed");
    expect(dispatched?.error?.name).toBe("RangeError");
    expect(dispatched?.error?.message).toBe("out-of-bounds");
    await queueB.shutdown();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Idempotency
// ════════════════════════════════════════════════════════════════════════════

describe("Queue.hydrate — idempotency", () => {
  test("hydrating an already-in-memory run returns the existing handle without invoking the factory", async () => {
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });
    let factoryCalls = 0;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create(
            makeEchoSpec("once", "hydrate-idempotent")
          );
          const d = queue.dispatch(wf);
          yield* Effect.promise(() => d.result());
          // First hydrate: should hit the in-memory cache, factory not called.
          const h1 = yield* Effect.promise(() =>
            queue.hydrate(d.id, () => {
              factoryCalls++;
              return Workflow.create(
                makeEchoSpec("once", "hydrate-idempotent")
              );
            })
          );
          // Second hydrate: also from cache.
          const h2 = yield* Effect.promise(() =>
            queue.hydrate(d.id, () => {
              factoryCalls++;
              return Workflow.create(
                makeEchoSpec("once", "hydrate-idempotent")
              );
            })
          );
          return { h1id: h1?.id, originalId: d.id, sameHandle: h1 === h2 };
        })
      )
    );
    expect(factoryCalls).toBe(0);
    expect(result.sameHandle).toBe(true);
    expect(result.h1id).toBe(result.originalId);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Missing runId
// ════════════════════════════════════════════════════════════════════════════

describe("Queue.hydrate — missing runId", () => {
  test("returns null when no row exists for the given runId; factory is not invoked", async () => {
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });
    let factoryCalls = 0;
    const result = await queue.hydrate("rn-does-not-exist", () => {
      factoryCalls++;
      return Workflow.create(makeEchoSpec("noop", "noop"));
    });
    expect(result).toBeNull();
    expect(factoryCalls).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. End-to-end: hydrate a suspended run on a fresh queue, then resume it
// ════════════════════════════════════════════════════════════════════════════

describe("Queue.hydrate — end-to-end resume after process restart", () => {
  test("hydrate(suspended) + resume() re-enqueues via the reactor armed by hydrate", {
    timeout: 10_000,
  }, async () => {
    // Round-trip the full lifecycle: dispatch on queueA, suspend, shut down
    // queueA. On a fresh queueB (different in-memory state, same DB), hydrate
    // the run by id, call resume. The reactor armed by hydrate picks up the
    // status flip and re-enqueues; queueB's driver runs the body to terminal.
    const store = makeInMemoryStore();
    const queueA = new Queue({ concurrency: 1, store });
    const runId = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Use the same spec from the suspended-run test above — proven
          // to suspend correctly inside this file.
          const wf = Workflow.create(
            makeSuspendingSpec(
              { reason: "external-decision", suspendName: "approval" },
              "hydrate-resume-e2e"
            )
          );
          const d = queueA.dispatch(wf);
          while (d.status !== "suspended") {
            yield* Effect.sleep(10);
          }
          yield* Effect.sleep(50);
          return d.id;
        })
      )
    );
    await queueA.shutdown();

    const queueB = new Queue({ concurrency: 1, store });
    // Factory rebuilds an equivalent suspending spec. After resume(),
    // the workflow re-enters #runOne; the body throws SuspendSignal
    // again, but step.run consults the resolutions map first and
    // short-circuits to return the resolved value before the body runs.
    const dispatched = await queueB.hydrate(runId, () =>
      Workflow.create(
        makeSuspendingSpec(
          { reason: "external-decision", suspendName: "approval" },
          "hydrate-resume-e2e"
        )
      )
    );
    expect(dispatched).not.toBeNull();
    expect(dispatched?.status).toBe("suspended");

    // Reactor armed in hydrate forwards the suspended → queued status
    // flip onto queueB's pendingQueue. The driver picks the run up
    // and re-runs the body. We track the transitions via the queue's
    // event listeners — `resumed` fires when the reactor offers the
    // run back, and `started` fires inside #runOne.
    const events: string[] = [];
    queueB.on("resumed", () => events.push("resumed"));
    queueB.on("started", () => events.push("started"));

    await new Promise<void>((r) => setTimeout(r, 20));
    if (!dispatched) {
      throw new Error("expected hydrated handle");
    }
    await dispatched.resume("approval", "approved-by-webhook");
    // Give the daemon + driver one cycle to react.
    await new Promise<void>((r) => setTimeout(r, 100));

    // The reactor fired (offered to pendingQueue) and the driver
    // picked the run up — proves the resume-after-hydrate seam works.
    expect(events).toContain("resumed");
    expect(events).toContain("started");
    await queueB.shutdown({ graceMs: 1000 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Cross-queue process restart simulation
// ════════════════════════════════════════════════════════════════════════════

describe("Queue.hydrate — process restart", () => {
  test("snapshot tree from the prior queue's persisted blob is seeded into the hydrated handle", async () => {
    // Workflow with a child step. After completion, the snapshot tree
    // should have entries for both the workflow and the child.
    const store = makeInMemoryStore();
    const queueA = new Queue({ concurrency: 1, store });
    const runId = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create({
            children: [
              {
                execute: async () => "leaf-out",
                input: undefined,
                name: "leaf",
              },
            ],
            execute: async (_input, ctx) => {
              await ctx.children[0]?.run();
              return "root-out";
            },
            input: undefined,
            name: "hydrate-tree",
          });
          const d = queueA.dispatch(wf);
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await queueA.drain();
    await queueA.shutdown();

    const queueB = new Queue({ concurrency: 1, store });
    const dispatched = await queueB.hydrate(runId, () =>
      Workflow.create({
        children: [
          {
            execute: async () => "leaf-out",
            input: undefined,
            name: "leaf",
          },
        ],
        execute: async (_input, ctx) => {
          await ctx.children[0]?.run();
          return "root-out";
        },
        input: undefined,
        name: "hydrate-tree",
      })
    );
    expect(dispatched).not.toBeNull();
    // Seeded steps from the prior run — both root and leaf are present
    // and complete in the hydrated snapshot.
    const steps = dispatched?.snapshot.steps;
    expect(steps?.["hydrate-tree"]?.status).toBe("complete");
    expect(steps?.["hydrate-tree.leaf"]?.status).toBe("complete");
    expect(dispatched?.results["hydrate-tree.leaf"]).toBe("leaf-out");
    await queueB.shutdown();
  });
});
