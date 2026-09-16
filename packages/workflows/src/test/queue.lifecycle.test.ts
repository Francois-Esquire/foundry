/**
 * Queue — full lifecycle integration narrative.
 *
 * Cancel mid-flight, suspension lifecycle, retry/timeout/Bail
 * interaction, the events firehose (queue.on), the queues.status row
 * transitions through pause/resume/drain, and streaming-through-dispatch.
 *
 * Basics (construction / dispatch handle / FIFO / concurrency cap /
 * queryable views / shutdown / restart-recovery smoke) live in
 * queue.test.ts. The runs-row persistence story (reactive writes,
 * mid-execution snapshot projection, the run.status-not-snap.status
 * terminal correction) lives in queue.persistence.test.ts.
 */

import { Effect, Fiber, Stream } from "effect";
import { describe, expect, test } from "vitest";

import { SuspendSignal } from "../executable";
import { Queue } from "../queue";
import { bail } from "../types";
import { Workflow } from "../workflow";
import {
  makeCounterSpec,
  makeEchoSpec,
  makeStreamingSpec,
  makeSuspendingSpec,
  makeTimeoutSpec,
} from "./fixtures/steps";
import { makeInMemoryStore } from "./helpers/store";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const store = makeInMemoryStore();

async function queueRecord(id: string) {
  return (await store.listQueues()).find((queue) => queue.id === id) ?? null;
}

function requireRecord<T>(record: T | null): T {
  if (!record) {
    throw new Error("expected persisted record");
  }
  return record;
}

// ════════════════════════════════════════════════════════════════════════════
// Lifecycle reflects to queues.status row (pause/resume/drain transitions)
// ════════════════════════════════════════════════════════════════════════════

describe("Queue — lifecycle persistence (queues.status)", () => {
  test("first lifecycle call lands the queue row with the new status", async () => {
    // The constructor fires the queue insert as fire-and-forget; the
    // first lifecycle call (pause/resume/drain) chains off it. After
    // pause(), the row is guaranteed visible with status='paused'.
    const queue = new Queue({ concurrency: 1, store });
    await queue.pause();
    const row = requireRecord(await queueRecord(queue.id));
    expect(row.status).toBe("paused");
  });

  test("resume() flips queues.status back to 'active'", async () => {
    const queue = new Queue({ concurrency: 1, store });
    await queue.pause();
    await queue.resume();
    const row = requireRecord(await queueRecord(queue.id));
    expect(row.status).toBe("active");
  });

  test("drain() with in-flight runs writes 'draining' then restores 'active'", async () => {
    const queue = new Queue({ concurrency: 1, store });

    const wf = Workflow.create({
      execute: async () => {
        await sleep(40);
        return "ok";
      },
      input: undefined,
      name: "drain-status",
    });
    queue.dispatch(wf);
    // Start drain in background; sample mid-flight then await.
    const drainP = queue.drain();
    await sleep(15);
    const mid = requireRecord(await queueRecord(queue.id));
    expect(mid.status).toBe("draining");
    await drainP;
    const final = requireRecord(await queueRecord(queue.id));
    expect(final.status).toBe("active");
  });

  test("drain() while paused restores 'paused' on completion", async () => {
    const queue = new Queue({ concurrency: 1, store });
    await queue.pause();

    const wf = Workflow.create({
      execute: async () => {
        await sleep(20);
        return "ok";
      },
      input: undefined,
      name: "drain-paused",
    });
    // Dispatch then resume so it can run; then re-pause; then drain.
    const d = queue.dispatch(wf);
    await queue.resume();
    await d.result();
    await queue.pause();
    // Drain on idle queue should be near-instant; status should
    // remain 'paused' after.
    await queue.drain();

    const row = requireRecord(await queueRecord(queue.id));
    expect(row.status).toBe("paused");
  });

  test("drain() rejects at its grace deadline and restores the prior status", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const wf = Workflow.create({
      execute: async (_input, ctx) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
          ctx.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true }
          );
        });
        return "ok";
      },
      input: undefined,
      name: "drain-timeout",
    });
    const dispatched = queue.dispatch(wf);

    await expect(queue.drain({ graceMs: 10 })).rejects.toThrow(
      "did not drain within 10 ms"
    );
    const row = requireRecord(await queueRecord(queue.id));
    expect(row.status).toBe("active");

    await dispatched.cancel("release drain timeout test");
    await dispatched.result();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Cancel
// ════════════════════════════════════════════════════════════════════════════

describe("Queue — cancel", () => {
  test("cancel a queued run before it starts settles status='cancelled'", async () => {
    const queue = new Queue({ concurrency: 1, store });
    await queue.pause();

    const wf = Workflow.create(makeEchoSpec("x", "cancel-queued"));
    const d = queue.dispatch(wf);
    await sleep(20);
    await d.cancel("user-stop-before-start");
    const result = await d.result();
    expect((result as { status: string }).status).toBe("cancelled");
  });

  test("cancel an in-flight run mid-execution interrupts the step", async () => {
    const queue = new Queue({ concurrency: 1, store });

    const wf = Workflow.create({
      execute: async () =>
        new Promise<never>((_resolve, reject) => {
          // The cancel surfaces as 'cancelled' regardless of cooperative
          // signal handling — long timer ensures the test asserts cancel
          // observability, not signal cooperation.
          setTimeout(() => {
            reject(new Error("not cancelled"));
          }, 5000);
        }),
      input: undefined,
      name: "cancel-mid",
    });
    const d = queue.dispatch(wf);
    await sleep(15);
    await d.cancel("mid-flight");
    const result = await d.result();
    expect((result as { status: string }).status).toBe("cancelled");
  });

  test("cancel after complete is a no-op", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const wf = Workflow.create(makeEchoSpec("x", "cancel-after"));
    const d = queue.dispatch(wf);
    const r1 = await d.result();
    // Cancel after complete — should not change the result.
    await d.cancel("late");
    const r2 = await d.result();
    expect((r1 as { status: string }).status).toBe("complete");
    expect((r2 as { status: string }).status).toBe("complete");
  });

  test("cancellation persists with status='cancelled'", async () => {
    const queue = new Queue({ concurrency: 1, store });

    const wf = Workflow.create({
      execute: async () =>
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new Error("nope"));
          }, 5000)
        ),
      input: undefined,
      name: "cancel-persist",
    });
    const d = queue.dispatch(wf);
    await sleep(15);
    await d.cancel("test");
    await d.result();
    await queue.drain();
    const row = requireRecord(await store.getRun(d.id));
    expect(row.status).toBe("cancelled");
  });

  test("cancel reason is propagated through dispatched.result().reason", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const wf = Workflow.create({
      execute: async () =>
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new Error("nope"));
          }, 5000)
        ),
      input: undefined,
      name: "cancel-reason",
    });
    const d = queue.dispatch(wf);
    await sleep(15);
    await d.cancel("explicit-reason");
    const r = await d.result();
    expect((r as { status: string; reason?: string }).status).toBe("cancelled");
    expect((r as { reason?: string }).reason).toBe("explicit-reason");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Suspension lifecycle
// ════════════════════════════════════════════════════════════════════════════

describe("Queue — suspension lifecycle", () => {
  test("a step calling suspend() releases the run's semaphore permit", async () => {
    // With concurrency=1, a suspended run must release its permit so a
    // second dispatch can start. Asserts only the permit-release; does not
    // round-trip through resume (see resume reactor lifetime finding).
    const queue = new Queue({ concurrency: 1, store });
    const startedSecond: string[] = [];

    const susp = Workflow.create(
      makeSuspendingSpec({ reason: "park", suspendName: "s" }, "perm-susp")
    );
    const second = Workflow.create({
      execute: async () => {
        startedSecond.push("started");
        return "ok" as const;
      },
      input: undefined,
      name: "perm-second",
    });
    queue.dispatch(susp);
    const dSecond = queue.dispatch(second);
    // Wait for second to run — only possible if the permit was released.
    await dSecond.result();
    expect(startedSecond).toContain("started");
  });

  test("size().suspended counts the parked run", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const wf = Workflow.create(
      makeSuspendingSpec({ reason: "wait", suspendName: "s" }, "sz-susp")
    );
    queue.dispatch(wf);
    await sleep(40);
    const sz = await queue.size();
    expect(sz.suspended).toBeGreaterThanOrEqual(1);
  });

  test("dispatched.resume(name, value) re-queues the run for replay", {
    timeout: 1500,
  }, async () => {
    // Surfaces the resume-reactor lifetime bug: the reactor is forked
    // inside #runOne which exits after emitting 'suspended' — so the
    // forked watcher is interrupted before resume() ever fires. The
    // test times out at result() awaiting the re-run that never happens.
    const queue = new Queue({ concurrency: 1, store });
    let executions = 0;

    const wf = Workflow.create({
      execute: async () => {
        executions++;
        if (executions === 1) {
          throw new SuspendSignal(
            {
              name: "wait",
              reason: "first time",
              suspendedAt: new Date().toISOString(),
            },
            ["rq-replay"]
          );
        }
        return "ok";
      },
      input: undefined,
      name: "rq-replay",
    });
    const d = queue.dispatch(wf);
    await sleep(40);
    await d.resume("wait", "ok");
    await d.result();
    expect(executions).toBeGreaterThanOrEqual(2);
  });

  test("on replay, execute is re-invoked after resume()", {
    timeout: 1500,
  }, async () => {
    // Same root cause as above — surfaces the resume reactor lifetime bug.
    const queue = new Queue({ concurrency: 1, store });
    const observedOnReplay: string[] = [];

    let runs = 0;
    const wf = Workflow.create({
      execute: async () => {
        runs++;
        if (runs === 1) {
          throw new SuspendSignal(
            {
              name: "n",
              reason: "first",
              suspendedAt: new Date().toISOString(),
            },
            ["short-circuit"]
          );
        }
        observedOnReplay.push(`run-${runs}`);
        return "ok";
      },
      input: undefined,
      name: "short-circuit",
    });
    const d = queue.dispatch(wf);
    await sleep(40);
    await d.resume("n", "the-value");
    await d.result();
    expect(observedOnReplay).toContain("run-2");
  });

  test("drain does not wait on a suspended run", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const wf = Workflow.create(
      makeSuspendingSpec({ reason: "park", suspendName: "n" }, "drain-susp")
    );
    queue.dispatch(wf);
    await sleep(40);
    const t0 = Date.now();
    await queue.drain();
    const elapsed = Date.now() - t0;
    // Drain should be near-instant when the only outstanding work is parked.
    expect(elapsed).toBeLessThan(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Retry / timeout / Bail interaction
// ════════════════════════════════════════════════════════════════════════════

describe("Queue — retry / timeout / Bail interaction", () => {
  test("step throw → result returns failed; queue continues with next run", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const bad = Workflow.create({
      execute: async () => {
        throw new Error("planned");
      },
      input: undefined,
      name: "bad",
    });
    const good = Workflow.create(makeEchoSpec("ok", "good"));
    const dBad = queue.dispatch(bad);
    const dGood = queue.dispatch(good);
    const r1 = await dBad.result();
    const r2 = await dGood.result();
    expect((r1 as { status: string }).status).toBe("failed");
    expect((r2 as { status: string }).status).toBe("complete");
  });

  test("Bail surfaces as failed without retry interaction", async () => {
    const queue = new Queue({ concurrency: 1, store });
    let attempts = 0;
    const wf = Workflow.create({
      // Even with retry, bail should be terminal on first call.
      config: { retry: { maxAttempts: 5 } },
      execute: async () => {
        attempts++;
        return bail<"refused">("refused");
      },
      input: undefined,
      name: "bailer",
    });
    const d = queue.dispatch(wf);
    const r = await d.result();
    expect((r as { status: string }).status).toBe("failed");
    expect(attempts).toBe(1);
  });

  test("retry policy on the dispatched step is honoured", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const { spec, getAttempts } = makeCounterSpec(
      3,
      { maxAttempts: 5 },
      "retry-honoured"
    );
    const wf = Workflow.create(spec);
    const d = queue.dispatch(wf);
    const r = await d.result();
    expect((r as { status: string; value?: unknown }).status).toBe("complete");
    expect((r as { value?: unknown }).value).toBe(3);
    expect(getAttempts()).toBe(3);
  });

  test("timeout on the dispatched step is honoured", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const wf = Workflow.create(makeTimeoutSpec(20, 200, "timeout-honoured"));
    const d = queue.dispatch(wf);
    const r = await d.result();
    expect((r as { status: string }).status).toBe("failed");
    expect(
      (r as { status: string; error?: { message?: string } }).error?.message
    ).toMatch(/timed out/i);
  });

  test("retry × timeout exhaustion: every attempt fires (count == maxAttempts)", async () => {
    const queue = new Queue({ concurrency: 1, store });
    let attempts = 0;
    const wf = Workflow.create({
      config: { retry: { maxAttempts: 3 }, timeout: 15 },
      execute: async () => {
        attempts++;
        await sleep(100);
        return "done" as const;
      },
      input: undefined,
      name: "retry-timeout",
    });
    const d = queue.dispatch(wf);
    const r = await d.result();
    expect((r as { status: string }).status).toBe("failed");
    expect(attempts).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Events firehose (queue.on)
// ════════════════════════════════════════════════════════════════════════════

describe("Queue — events firehose (queue.on)", () => {
  test("'dispatched' fires synchronously after dispatch returns", async () => {
    const queue = new Queue({ concurrency: 1, store });
    await queue.pause();
    const seen: string[] = [];
    queue.on("dispatched", (p) => seen.push(p.runId));

    const wf = Workflow.create(makeEchoSpec("x", "ev-dispatched"));
    const d = queue.dispatch(wf);
    // dispatched is synchronous — no sleep needed.
    expect(seen).toContain(d.id);
    await queue.resume();
    await d.result();
  });

  test("'started' fires when the run picks up a permit", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const seen: string[] = [];
    queue.on("started", (p) => seen.push(p.runId));

    const wf = Workflow.create(makeEchoSpec("x", "ev-started"));
    const d = queue.dispatch(wf);
    await d.result();
    expect(seen).toContain(d.id);
  });

  test("'complete' fires once on success (after drain)", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const seen: string[] = [];
    queue.on("complete", (p) => seen.push(p.runId));

    const wf = Workflow.create(makeEchoSpec("x", "ev-complete"));
    const d = queue.dispatch(wf);
    await d.result();
    await queue.drain();
    expect(seen.filter((seenId) => seenId === d.id).length).toBe(1);
  });

  test("'failed' fires once on throw (after drain)", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const seen: string[] = [];
    queue.on("failed", (p) => seen.push(p.runId));

    const wf = Workflow.create({
      execute: async () => {
        throw new Error("boom");
      },
      input: undefined,
      name: "ev-failed",
    });
    const d = queue.dispatch(wf);
    await d.result();
    await queue.drain();
    expect(seen.filter((seenId) => seenId === d.id).length).toBe(1);
  });

  test("'cancelled' fires once when cancelled mid-flight (after drain)", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const seen: string[] = [];
    queue.on("cancelled", (p) => seen.push(p.runId));

    const wf = Workflow.create({
      execute: async () =>
        new Promise<never>(() => {
          /* never resolves */
        }),
      input: undefined,
      name: "ev-cancelled",
    });
    const d = queue.dispatch(wf);
    await sleep(15);
    await d.cancel("test");
    await d.result();
    await queue.drain();
    expect(seen.filter((seenId) => seenId === d.id).length).toBe(1);
  });

  test("'suspended' fires when the step parks", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const seen: string[] = [];
    queue.on("suspended", (p) => seen.push(p.runId));

    const wf = Workflow.create(
      makeSuspendingSpec(
        { reason: "needs sign-off", suspendName: "approve" },
        "ev-suspended"
      )
    );
    const d = queue.dispatch(wf);
    // Wait for suspension to land + queue bookkeeping.
    await sleep(40);
    expect(seen).toContain(d.id);
  });

  test("'resumed' fires when a suspended run is resumed", async () => {
    const queue = new Queue({ concurrency: 1, store });
    const seen: string[] = [];
    queue.on("resumed", (p) => seen.push(p.runId));

    // Suspend once on first attempt, succeed on resume.
    let attempts = 0;
    const wf = Workflow.create({
      execute: async () => {
        attempts++;
        if (attempts === 1) {
          throw new SuspendSignal(
            {
              name: "x",
              reason: "wait",
              suspendedAt: new Date().toISOString(),
            },
            ["ev-resumed"]
          );
        }
        return "ok";
      },
      input: undefined,
      name: "ev-resumed",
    });
    const d = queue.dispatch(wf);
    await sleep(40);
    await d.resume("x", "go");
    await d.result();
    await queue.drain();
    expect(seen).toContain(d.id);
  });

  test("event payload carries runId, step name, status, at (after drain)", async () => {
    const queue = new Queue({ concurrency: 1, store });
    let payload: {
      runId: string;
      step: string;
      status: string;
      at: string;
    } | null = null;
    queue.on("complete", (p) => {
      payload = p;
    });

    const wf = Workflow.create(makeEchoSpec("x", "ev-payload"));
    const d = queue.dispatch(wf);
    await d.result();
    await queue.drain();
    expect(payload).not.toBeNull();
    const p = payload as unknown as {
      runId: string;
      step: string;
      status: string;
      at: string;
    };
    expect(p.runId).toMatch(/^rn-/);
    expect(p.step).toBe("ev-payload");
    expect(p.status).toBe("complete");
    expect(p.at).toBeTypeOf("string");
  });

  test("the unsubscribe function returned by on() stops further callbacks (after drain)", async () => {
    const queue = new Queue({ concurrency: 1, store });
    let count = 0;
    const unsub = queue.on("complete", () => {
      count++;
    });

    const a = Workflow.create(makeEchoSpec("x", "ev-unsub-a"));
    const da = queue.dispatch(a);
    await da.result();
    await queue.drain();
    expect(count).toBe(1);

    unsub();

    const b = Workflow.create(makeEchoSpec("x", "ev-unsub-b"));
    const db = queue.dispatch(b);
    await db.result();
    await queue.drain();
    expect(count).toBe(1);
  });

  test("a throwing handler does not break the firehose for other handlers (after drain)", async () => {
    const queue = new Queue({ concurrency: 1, store });
    let goodCount = 0;
    queue.on("complete", () => {
      throw new Error("first handler boom");
    });
    queue.on("complete", () => {
      goodCount++;
    });

    const wf = Workflow.create(makeEchoSpec("x", "ev-throw"));
    const d = queue.dispatch(wf);
    await d.result();
    await queue.drain();
    expect(goodCount).toBe(1);
  });

  test("events fire across multiple concurrent runs without crosstalk (after drain)", async () => {
    const queue = new Queue({ concurrency: 3, store });
    const completedIds: string[] = [];
    queue.on("complete", (p) => completedIds.push(p.runId));

    const wfs = Array.from({ length: 5 }, (_, i) =>
      Workflow.create(makeEchoSpec(i, `ev-many-${i}`))
    );
    const ds = wfs.map((wf) => queue.dispatch(wf));
    await Promise.all(ds.map((d) => d.result()));
    await queue.drain();
    const ids = ds.map((d) => d.id);
    expect(completedIds.length).toBe(5);
    for (const id of ids) {
      expect(completedIds.filter((seen) => seen === id).length).toBe(1);
    }
  });

  test("queue.on('restarted') / on('queue_failed') / on('persist_failed') return working unsubscribes (smoke)", () => {
    // Wiring smoke test: the listener machinery exists for these events
    // and returns an unsubscribe. Reliably triggering an actual driver-loop
    // failure or DAO write rejection is brittle without a fault-injection
    // seam, so the deeper integration tests are deferred.
    const queue = new Queue({ concurrency: 1, store });
    const unsubR = queue.on("restarted", () => {});
    const unsubF = queue.on("queue_failed", () => {});
    const unsubP = queue.on("persist_failed", () => {});
    expect(typeof unsubR).toBe("function");
    expect(typeof unsubF).toBe("function");
    expect(typeof unsubP).toBe("function");
    unsubR();
    unsubF();
    unsubP();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Streaming through dispatch
// ════════════════════════════════════════════════════════════════════════════

describe("Queue — streaming through dispatch", () => {
  test("dispatched run's chunks surface on the workflow's step channels", async () => {
    const queue = new Queue({ concurrency: 1, store });

    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seen: unknown[] = [];
          const { spec, setStep } = makeStreamingSpec(
            { chunks: ["a", "b", "c"] },
            "stream-dispatch"
          );
          const wf = Workflow.create(spec);
          setStep(wf.root);
          // Subscribe via the Effect Stream surface BEFORE dispatch.
          const subscriberFiber = yield* Effect.fork(
            wf.root.channels.chunks.stream.pipe(
              Stream.runForEach((tagged) =>
                Effect.sync(() => {
                  if (tagged.payload.kind === "data") {
                    seen.push(tagged.payload.data);
                  } else {
                    seen.push(tagged.payload.text);
                  }
                })
              )
            )
          );
          const d = queue.dispatch(wf);
          yield* Effect.promise(() => d.result());
          // Give the subscriber fiber a tick to drain.
          yield* Effect.sleep(20);
          yield* Fiber.interrupt(subscriberFiber);
          return seen;
        })
      )
    );
    expect(collected).toEqual(["a", "b", "c"]);
  });

  test("chunks survive across queue pause/resume of the driver loop", async () => {
    const queue = new Queue({ concurrency: 1, store });

    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seen: unknown[] = [];
          const { spec, setStep } = makeStreamingSpec(
            { chunks: ["pre", "mid", "post"], delayMs: 20 },
            "stream-pauseresume"
          );
          const wf = Workflow.create(spec);
          setStep(wf.root);
          const subscriberFiber = yield* Effect.fork(
            wf.root.channels.chunks.stream.pipe(
              Stream.runForEach((tagged) =>
                Effect.sync(() => {
                  if (tagged.payload.kind === "data") {
                    seen.push(tagged.payload.data);
                  } else {
                    seen.push(tagged.payload.text);
                  }
                })
              )
            )
          );
          const d = queue.dispatch(wf);
          yield* Effect.sleep(25);
          yield* Effect.promise(() => queue.pause());
          yield* Effect.sleep(20);
          yield* Effect.promise(() => queue.resume());
          yield* Effect.promise(() => d.result());
          yield* Effect.sleep(20);
          yield* Fiber.interrupt(subscriberFiber);
          return seen;
        })
      )
    );
    expect(collected).toEqual(["pre", "mid", "post"]);
  });
});
