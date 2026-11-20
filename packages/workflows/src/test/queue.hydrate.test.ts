import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { Queue } from "../queue";
import { Workflow } from "../workflow";
import { makeEchoSpec, makeSuspendingSpec } from "./fixtures/steps";
import { makeInMemoryStore } from "./helpers/store";

describe("Queue.hydrate — terminal run", () => {
  test("hydrates a completed run; sync accessors reflect persisted state", async () => {
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

    const queueB = new Queue({ concurrency: 1, store });
    const dispatched = await queueB.hydrate(runId, (recoverable) =>
      Workflow.create(
        makeEchoSpec(recoverable.input as string, "hydrate-complete")
      )
    );
    expect(dispatched).not.toBeNull();
    expect(dispatched?.id).toBe(runId);
    expect(dispatched?.status).toBe("complete");
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
          const h1 = yield* Effect.promise(() =>
            queue.hydrate(d.id, () => {
              factoryCalls += 1;
              return Workflow.create(
                makeEchoSpec("once", "hydrate-idempotent")
              );
            })
          );
          const h2 = yield* Effect.promise(() =>
            queue.hydrate(d.id, () => {
              factoryCalls += 1;
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

describe("Queue.hydrate — missing runId", () => {
  test("returns null when no row exists for the given runId; factory is not invoked", async () => {
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });
    let factoryCalls = 0;
    const result = await queue.hydrate("rn-does-not-exist", () => {
      factoryCalls += 1;
      return Workflow.create(makeEchoSpec("noop", "noop"));
    });
    expect(result).toBeNull();
    expect(factoryCalls).toBe(0);
  });
});

describe("Queue.hydrate — end-to-end resume after process restart", () => {
  test("hydrate(suspended) + resume() re-enqueues via the reactor armed by hydrate", {
    timeout: 10_000,
  }, async () => {
    const store = makeInMemoryStore();
    const queueA = new Queue({ concurrency: 1, store });
    const runId = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
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

    const events: string[] = [];
    queueB.on("resumed", () => events.push("resumed"));
    queueB.on("started", () => events.push("started"));

    await new Promise<void>((r) => setTimeout(r, 20));
    if (!dispatched) {
      throw new Error("expected hydrated handle");
    }
    await dispatched.resume("approval", "approved-by-webhook");
    await new Promise<void>((r) => setTimeout(r, 100));

    expect(events).toContain("resumed");
    expect(events).toContain("started");
    await queueB.shutdown({ graceMs: 1000 });
  });
});

describe("Queue.hydrate — process restart", () => {
  test("snapshot tree from the prior queue's persisted blob is seeded into the hydrated handle", async () => {
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
    const steps = dispatched?.snapshot.steps;
    expect(steps?.["hydrate-tree"]?.status).toBe("complete");
    expect(steps?.["hydrate-tree.leaf"]?.status).toBe("complete");
    expect(dispatched?.results["hydrate-tree.leaf"]).toBe("leaf-out");
    await queueB.shutdown();
  });
});
