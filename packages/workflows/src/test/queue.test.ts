/**
 * Queue — basics and the smoke-level lifecycle.
 *
 * Construction, dispatch handle shape, FIFO at concurrency 1, the
 * concurrency cap, pause/resume/drain controls, queryable views, the
 * shutdown surface, and restart-recovery smoke. The deeper lifecycle /
 * suspension / events / cancel / retry-timeout / streaming surface
 * lives in queue.lifecycle.test.ts.
 */

import { describe, expect, test } from "vitest";

import { SuspendSignal } from "../executable";
import { Queue } from "../queue";
import { Workflow } from "../workflow";
import { makeEchoSpec } from "./fixtures/steps";
import { makeInMemoryStore } from "./helpers/store";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const store = makeInMemoryStore();

async function queueRecord(id: string) {
  return (await store.listQueues()).find((queue) => queue.id === id) ?? null;
}

describe("Queue — construction", () => {
  test("constructs with a store and concurrency", () => {
    const queue = new Queue({ concurrency: 4, store });
    expect(queue).toBeInstanceOf(Queue);
    expect(queue.options.concurrency).toBe(4);
    expect(queue.options.store).toBe(store);
  });

  test("preserves an optional logger config on the instance", () => {
    const logger = {
      on: () => {},
    };
    const queue = new Queue({ concurrency: 1, logger, store });
    expect(queue.options.logger).toBe(logger);
  });

  test("generates a fresh qu-* id when none is provided", () => {
    const a = new Queue({ concurrency: 1, store });
    const b = new Queue({ concurrency: 1, store });
    expect(a.id).toMatch(/^qu-/);
    expect(b.id).toMatch(/^qu-/);
    expect(a.id).not.toBe(b.id);
  });

  test("attaches to an existing queue row when an id is reused (onConflictDoNothing)", () => {
    const sharedId = "qu_shared_test_id";
    const a = new Queue({ concurrency: 1, id: sharedId, store });
    expect(a.id).toBe(sharedId);
    // Re-construct against the same id; should not throw on FK / unique conflict.
    expect(
      () => new Queue({ concurrency: 2, id: sharedId, store })
    ).not.toThrow();
  });
});

describe("Queue.dispatch — handle shape", () => {
  test("rejects Job links outside managed Orchestrator execution", async () => {
    const localStore = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store: localStore });
    expect(() =>
      queue.dispatch(Workflow.create(makeEchoSpec("x", "linked")), {
        links: { jobId: "jb-bypass" },
      } as never)
    ).toThrow(/Orchestrator\.execute/);
    expect((await localStore.listRuns({})).items).toEqual([]);
    await queue.shutdown();
  });

  test("retains a durable Job claim when fresh admission is rejected", async () => {
    const localStore = makeInMemoryStore();
    const queue = new Queue({
      concurrency: 1,
      id: "qu-admission-race",
      store: localStore,
    });
    const job = await localStore.createJob({
      definition: { name: "managed" },
      input: null,
    });
    const claim = await localStore.claimJobRun(job.id, {
      id: "rn-admission-race",
      input: null,
      queueId: queue.id,
      step: "managed",
    });
    await queue.shutdown();

    expect(() =>
      queue.dispatchPersisted(Workflow.create(makeEchoSpec("x", "managed")), {
        definition: claim.run.definition,
        extensions: claim.run.extensions,
        id: claim.run.id,
        input: claim.run.input,
        lastStatus: claim.run.status,
        links: claim.run.links,
        metadata: claim.run.metadata,
        step: claim.run.step,
      })
    ).toThrow(/shut down/);
    await expect(localStore.getRun(claim.run.id)).resolves.toMatchObject({
      links: { jobId: job.id },
      status: "queued",
    });
    await expect(localStore.getJob(job.id)).resolves.toMatchObject({
      status: "active",
    });
  });

  test("accepts a supplied Run ID and rejects a live duplicate", async () => {
    const localStore = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store: localStore });
    const suppliedId = "rn-supplied";
    const dispatched = queue.dispatch(
      Workflow.create(makeEchoSpec("first", "supplied")),
      { runId: suppliedId }
    );

    expect(dispatched.id).toBe(suppliedId);
    expect(() =>
      queue.dispatch(Workflow.create(makeEchoSpec("second", "duplicate")), {
        runId: suppliedId,
      })
    ).toThrow(/already exists/i);
    await dispatched.result();
    await expect(localStore.getRun(suppliedId)).resolves.toMatchObject({
      id: suppliedId,
      step: "supplied",
    });
    await queue.shutdown();
  });

  test("settles a supplied-ID handle when another Queue already persisted it", async () => {
    const localStore = makeInMemoryStore();
    const firstQueue = new Queue({ concurrency: 1, store: localStore });
    const suppliedId = "rn-persisted-duplicate";
    const first = firstQueue.dispatch(
      Workflow.create(makeEchoSpec("first", "first-owner")),
      { runId: suppliedId }
    );
    await first.result();

    const secondQueue = new Queue({ concurrency: 1, store: localStore });
    const duplicate = secondQueue.dispatch(
      Workflow.create(makeEchoSpec("second", "second-owner")),
      { runId: suppliedId }
    );
    await expect(secondQueue.awaitPersistence(duplicate.id)).rejects.toThrow(
      /already exists/i
    );
    const duplicateResult = await duplicate.result();
    if (
      typeof duplicateResult !== "object" ||
      duplicateResult === null ||
      !("status" in duplicateResult) ||
      !("error" in duplicateResult) ||
      !(duplicateResult.error instanceof Error)
    ) {
      throw new Error("Expected a failed workflow result");
    }
    expect(duplicateResult.status).toBe("failed");
    expect(duplicateResult.error.message).toMatch(/exists/i);
    await expect(secondQueue.awaitPersistence(duplicate.id)).rejects.toThrow(
      /already exists/i
    );
    expect(duplicate.status).toBe("failed");
    await expect(localStore.getRun(suppliedId)).resolves.toMatchObject({
      status: "complete",
      step: "first-owner",
    });

    await Promise.all([firstQueue.shutdown(), secondQueue.shutdown()]);
  });

  test("returns a DispatchedWorkflow synchronously with id, step name, status='queued'", async () => {
    const queue = new Queue({ concurrency: 1, store });
    await queue.pause(); // prevent the driver from picking it up before we inspect

    const wf = Workflow.create(makeEchoSpec("hello", "echo"));
    const dispatched = queue.dispatch(wf);
    expect(dispatched.id).toMatch(/^rn-/);
    expect(dispatched.step).toBe("echo");
    expect(dispatched.status).toBe("queued");
    expect(dispatched.queueId).toBe(queue.id);
  });

  test("delivers the step's output through dispatched.result()", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const wf = Workflow.create(makeEchoSpec("hello", "echo"));
    const dispatched = queue.dispatch(wf);
    const result = await dispatched.result();
    expect(result).toMatchObject({ status: "complete", value: "hello" });
  });

  test("dispatch persists the run row with status='queued'", async () => {
    const queue = new Queue({ concurrency: 1, store });
    await queue.pause(); // hold the run in queued state

    const wf = Workflow.create(makeEchoSpec("x", "persist-me"));
    const d = queue.dispatch(wf);
    // Give the chained insert a moment to land.
    await sleep(20);

    const row = await store.getRun(d.id);
    if (!row) {
      throw new Error("expected persisted run");
    }
    expect(row.id).toBe(d.id);
    expect(row.queueId).toBe(queue.id);
    expect(row.status).toBe("queued");
    expect(row.step).toBe("persist-me");
  });
});

describe("Queue — FIFO ordering", () => {
  test("processes dispatched runs in arrival order at concurrency 1", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const a = Workflow.create(makeEchoSpec("a", "wf-a"));
    const b = Workflow.create(makeEchoSpec("b", "wf-b"));
    const c = Workflow.create(makeEchoSpec("c", "wf-c"));
    const da = queue.dispatch(a);
    const db = queue.dispatch(b);
    const dc = queue.dispatch(c);
    const results = await Promise.all([da.result(), db.result(), dc.result()]);
    const observed = results.map((r) =>
      (r as { status: string; value?: unknown }).status === "complete"
        ? (r as { value: unknown }).value
        : null
    );
    expect(observed).toEqual(["a", "b", "c"]);
  });

  test("a slow run does not let a later dispatched run skip ahead", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const completed: string[] = [];

    const slow = Workflow.create({
      execute: async () => {
        await sleep(40);
        completed.push("slow");
        return "slow" as const;
      },
      input: undefined,
      name: "slow",
    });
    const quick = Workflow.create({
      execute: async () => {
        completed.push("quick");
        return "quick" as const;
      },
      input: undefined,
      name: "quick",
    });
    const ds = queue.dispatch(slow);
    const dq = queue.dispatch(quick);
    await Promise.all([ds.result(), dq.result()]);

    // At concurrency 1, slow's permit blocks quick from starting until slow
    // finishes — so 'slow' must complete first even though 'quick' is faster.
    expect(completed).toEqual(["slow", "quick"]);
  });
});

describe("Queue — concurrency cap", () => {
  test("never exceeds the configured concurrency under load", async () => {
    const cap = 2;
    const queue = new Queue({ concurrency: cap, store });
    let inFlight = 0;
    let max = 0;

    const wfs = Array.from({ length: 6 }, (_, i) =>
      Workflow.create({
        execute: async () => {
          inFlight++;
          if (inFlight > max) {
            max = inFlight;
          }
          await sleep(15);
          inFlight--;
          return i;
        },
        input: i,
        name: `cap-${i}`,
      })
    );
    const ds = wfs.map((wf) => queue.dispatch(wf));
    await Promise.all(ds.map((d) => d.result()));

    expect(max).toBeLessThanOrEqual(cap);
    expect(max).toBeGreaterThan(0);
  });

  test("starts pending runs as permits free", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const startTimes: number[] = [];
    const make = (name: string) =>
      Workflow.create({
        execute: async () => {
          startTimes.push(Date.now());
          await sleep(25);
          return name;
        },
        input: undefined,
        name,
      });
    const ds = [make("a"), make("b"), make("c")].map((wf) =>
      queue.dispatch(wf)
    );
    await Promise.all(ds.map((d) => d.result()));
    // Three runs at concurrency 1 should start sequentially, ~25ms apart.
    expect(startTimes).toHaveLength(3);
    const [t0, t1, t2] = startTimes;
    if (t0 === undefined || t1 === undefined || t2 === undefined) {
      throw new Error("expected three start times");
    }
    expect(t1 - t0).toBeGreaterThanOrEqual(20);
    expect(t2 - t1).toBeGreaterThanOrEqual(20);
  });
});

describe("Queue — host fairness", () => {
  test("yields to the host while draining an immediately-ready backlog", async () => {
    const queue = new Queue({
      concurrency: 1,
      store: makeInMemoryStore(),
    });
    const runCount = 16;
    let completed = 0;

    try {
      const runs = Array.from({ length: runCount }, (_, index) =>
        queue.dispatch(
          Workflow.create({
            execute: async (value) => {
              completed += 1;
              return value;
            },
            input: index,
            name: `fair-${index}`,
          })
        )
      );
      const hostTurn = new Promise<number>((resolve) => {
        setTimeout(() => {
          resolve(completed);
        }, 0);
      });

      const [completedAtHostTurn] = await Promise.all([
        hostTurn,
        Promise.all(runs.map((run) => run.result())),
      ]);

      expect(completedAtHostTurn).toBeLessThan(runCount);
    } finally {
      await queue.shutdown();
    }
  });
});

describe("Queue — pause / resume", () => {
  test("pause prevents new dispatches from starting; resume releases them", async () => {
    const queue = new Queue({ concurrency: 1, store });
    await queue.pause();

    const wf = Workflow.create(makeEchoSpec("x", "paused"));
    const d = queue.dispatch(wf);
    // Give the driver a chance to pick it up if it would.
    await sleep(30);
    expect(d.status).toBe("queued");

    await queue.resume();
    const result = await d.result();
    expect((result as { status: string }).status).toBe("complete");
  });

  test("dispatch while paused queues the run but leaves it pending", async () => {
    const queue = new Queue({ concurrency: 1, store });
    await queue.pause();

    const wf = Workflow.create(makeEchoSpec("x", "while-paused"));
    const d = queue.dispatch(wf);
    await sleep(30);
    expect(d.status).toBe("queued");
    const sz = await queue.size();
    expect(sz.pending).toBeGreaterThanOrEqual(1);
    // Cleanup so afterAll doesn't leave a hanging run.
    await queue.resume();
    await d.result();
  });

  test("multiple pause/resume cycles are idempotent", async () => {
    const queue = new Queue({ concurrency: 1, store });

    await queue.pause();
    await queue.pause();
    await queue.resume();
    await queue.resume();
    await queue.pause();
    await queue.resume();

    // After all that toggling the queue should still process a dispatch.
    const wf = Workflow.create(makeEchoSpec("ok", "after-toggle"));
    const d = queue.dispatch(wf);
    const r = await d.result();
    expect((r as { status: string }).status).toBe("complete");
  });
});

describe("Queue — drain", () => {
  test("resolves immediately when no runs are outstanding", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const t0 = Date.now();
    await queue.drain();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test("awaits all in-flight runs to terminal", async () => {
    const queue = new Queue({ concurrency: 2, store });
    const wfs = Array.from({ length: 4 }, (_, i) =>
      Workflow.create({
        execute: async () => {
          await sleep(20);
          return i;
        },
        input: i,
        name: `drain-${i}`,
      })
    );
    for (const wf of wfs) {
      queue.dispatch(wf);
    }
    // Don't await results — drain is what we're testing.
    await queue.drain();
    const sz = await queue.size();
    expect(sz.pending).toBe(0);
    expect(sz.active).toBe(0);
    expect(sz.complete).toBe(4);
  });

  test("includes pending (not yet started) runs in the wait", async () => {
    const queue = new Queue({ concurrency: 1, store });
    // 3 sequential runs at concurrency 1 — drain must await all three.
    const wfs = Array.from({ length: 3 }, (_, i) =>
      Workflow.create({
        execute: async () => {
          await sleep(15);
          return i;
        },
        input: i,
        name: `seq-${i}`,
      })
    );
    for (const wf of wfs) {
      queue.dispatch(wf);
    }
    const t0 = Date.now();
    await queue.drain();
    // 3 × 15ms minimum.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    const sz = await queue.size();
    expect(sz.complete).toBe(3);
  });
});

describe("Queue — queryable views", () => {
  test("get(id) returns the dispatched run handle", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const wf = Workflow.create(makeEchoSpec("x", "lookup"));
    const d = queue.dispatch(wf);
    const fetched = await queue.get(d.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(d.id);
    await d.result();
  });

  test("get(unknownId) returns null", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const r = await queue.get("rn-does-not-exist");
    expect(r).toBeNull();
  });

  test("active() reflects currently-running runs only", async () => {
    const queue = new Queue({ concurrency: 2, store });
    const wfs = Array.from({ length: 2 }, (_, i) =>
      Workflow.create({
        execute: async () => {
          await sleep(30);
          return i;
        },
        input: i,
        name: `active-${i}`,
      })
    );
    for (const wf of wfs) {
      queue.dispatch(wf);
    }
    // Wait for them to start running.
    await sleep(10);
    const running = queue.active();
    expect(running.length).toBe(2);
    expect(running.every((r) => r.status === "running")).toBe(true);
    await queue.drain();
    expect(queue.active().length).toBe(0);
  });

  test("pending() reflects queued runs only", async () => {
    const queue = new Queue({ concurrency: 1, store });
    // First wf takes a permit; subsequent dispatches queue.
    const slow = Workflow.create({
      execute: async () => {
        await sleep(40);
        return "done";
      },
      input: undefined,
      name: "blocker",
    });
    const queued1 = Workflow.create(makeEchoSpec("x", "p-1"));
    const queued2 = Workflow.create(makeEchoSpec("x", "p-2"));
    queue.dispatch(slow);
    queue.dispatch(queued1);
    queue.dispatch(queued2);
    await sleep(10);
    const pending = queue.pending();
    expect(pending.length).toBe(2);
    expect(pending.every((r) => r.status === "queued")).toBe(true);
    await queue.drain();
  });

  test("size() returns counts per status", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const ok1 = Workflow.create(makeEchoSpec("x", "ok-1"));
    const ok2 = Workflow.create(makeEchoSpec("x", "ok-2"));
    const bad = Workflow.create({
      execute: async () => {
        throw new Error("boom");
      },
      input: undefined,
      name: "bad",
    });
    queue.dispatch(ok1);
    queue.dispatch(ok2);
    queue.dispatch(bad);
    await queue.drain();
    const sz = await queue.size();
    expect(sz.complete).toBe(2);
    expect(sz.failed).toBe(1);
    expect(sz.pending).toBe(0);
    expect(sz.active).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Shutdown — graceful teardown of the driver fiber and queues.status row
// ════════════════════════════════════════════════════════════════════════════

describe("Queue — shutdown", () => {
  test("shutdown() on an idle queue resolves quickly and writes status='stopped'", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const t0 = Date.now();
    await queue.shutdown();
    expect(Date.now() - t0).toBeLessThan(200);
    const row = await queueRecord(queue.id);
    if (!row) {
      throw new Error("expected persisted queue");
    }
    expect(row.status).toBe("stopped");
  });

  test("shutdown() with an in-flight run waits for drain (within graceMs)", async () => {
    const queue = new Queue({ concurrency: 1, store });
    let runDone = false;

    const wf = Workflow.create({
      execute: async () => {
        await sleep(30);
        runDone = true;
        return "ok";
      },
      input: undefined,
      name: "shutdown-drain",
    });
    queue.dispatch(wf);
    // Give the driver a moment to start the run.
    await sleep(10);
    // Shutdown with ample grace; should wait for completion.
    await queue.shutdown({ graceMs: 500 });
    expect(runDone).toBe(true);
    const row = await queueRecord(queue.id);
    if (!row) {
      throw new Error("expected persisted queue");
    }
    expect(row.status).toBe("stopped");
  });

  test("shutdown() with graceMs=0 proceeds immediately and still marks 'stopped'", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const wf = Workflow.create({
      execute: async () =>
        new Promise<string>((_resolve) => {
          /* never resolves */
        }),
      input: undefined,
      name: "shutdown-grace-0",
    });
    queue.dispatch(wf);
    await sleep(10);
    await queue.shutdown({ graceMs: 0 });
    const row = await queueRecord(queue.id);
    if (!row) {
      throw new Error("expected persisted queue");
    }
    expect(row.status).toBe("stopped");
  });

  test("double-shutdown is idempotent (returns the same promise)", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const a = queue.shutdown();
    const b = queue.shutdown();
    expect(a).toBe(b);
    await a;
  });

  test("dispatch() after shutdown throws", async () => {
    const queue = new Queue({ concurrency: 1, store });
    await queue.shutdown();
    const wf = Workflow.create(makeEchoSpec("x", "after-shutdown"));
    expect(() => queue.dispatch(wf)).toThrow(/shut down/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Restart-recovery — production-parity smoke
// ════════════════════════════════════════════════════════════════════════════

describe("Restart recovery — findRecoverableRuns()", () => {
  test("a fresh Queue against the same db surfaces queued+suspended rows from a prior session", async () => {
    const sharedId = "qu-recover-mixed";
    const queueA = new Queue({
      concurrency: 1,
      id: sharedId,
      store,
    });
    await queueA.pause();

    const wf = Workflow.create(makeEchoSpec("payload-1", "echo-1"));
    const d1 = queueA.dispatch(wf);
    // Wait for row insert to land.
    await sleep(20);

    // Spin up a fresh Queue instance pointing at the same db row.
    const queueB = new Queue({
      concurrency: 1,
      id: sharedId,
      store,
    });
    await queueB.pause();
    const recoverable = await queueB.findRecoverableRuns();
    const found = recoverable.find((r) => r.id === d1.id);
    expect(found).toBeDefined();
    expect(found?.step).toBe("echo-1");
    expect(found?.input).toBe("payload-1");
    expect(found?.lastStatus).toBe("queued");
  });

  test("a fresh Queue does NOT re-surface rows already in status='complete'", async () => {
    const sharedId = "qu-recover-complete";
    const queueA = new Queue({
      concurrency: 1,
      id: sharedId,
      store,
    });

    const wf = Workflow.create(makeEchoSpec("done", "echo-done"));
    const d = queueA.dispatch(wf);
    await d.result();
    await queueA.drain();

    const queueB = new Queue({
      concurrency: 1,
      id: sharedId,
      store,
    });
    const recoverable = await queueB.findRecoverableRuns();
    expect(recoverable.find((r) => r.id === d.id)).toBeUndefined();
  });

  test("a fresh Queue surfaces 'suspended' rows with their suspension payload", async () => {
    const sharedId = "qu-recover-suspended";
    const queueA = new Queue({
      concurrency: 1,
      id: sharedId,
      store,
    });

    const wf = Workflow.create({
      execute: async () => {
        throw new SuspendSignal(
          {
            meta: { reviewer: "ops" },
            name: "approve",
            reason: "needs sign-off",
            suspendedAt: new Date().toISOString(),
          },
          ["needs-approval"]
        );
      },
      input: { ticket: 42 },
      name: "needs-approval",
    });
    const d = queueA.dispatch(wf);
    // Wait for suspension to land + persist.
    await sleep(50);

    const queueB = new Queue({
      concurrency: 1,
      id: sharedId,
      store,
    });
    const recoverable = await queueB.findRecoverableRuns();
    const found = recoverable.find((r) => r.id === d.id);
    expect(found).toBeDefined();
    expect(found?.lastStatus).toBe("suspended");
    expect(found?.step).toBe("needs-approval");
    expect(found?.suspension?.name).toBe("approve");
    expect(found?.suspension?.reason).toBe("needs sign-off");
    expect((found?.input as { ticket?: number } | undefined)?.ticket).toBe(42);
  });

  test("findRecoverableRuns is scoped to this queue's id (no cross-queue leakage)", async () => {
    const queueA = new Queue({
      concurrency: 1,
      id: "qu-recover-scope-a",
      store,
    });
    await queueA.pause();
    const queueB = new Queue({
      concurrency: 1,
      id: "qu-recover-scope-b",
      store,
    });
    await queueB.pause();

    const wfA = Workflow.create(makeEchoSpec("x", "scope-a"));
    const dA = queueA.dispatch(wfA);
    await sleep(20);

    const recoverableB = await queueB.findRecoverableRuns();
    expect(recoverableB.find((r) => r.id === dA.id)).toBeUndefined();
  });
});
