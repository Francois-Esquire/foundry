/**
 * Step skip-on-complete — Stage 4 / P0-2 isolated path.
 *
 * step.run() consults the persisted snapshot before firing started/complete.
 * If the seeded record at this step's path has status="complete", the body
 * short-circuits and returns the persisted output — no events fire, the
 * execute body is never invoked. Any other persisted status (failed,
 * suspended, running, pending) re-runs normally; absence re-runs normally.
 *
 * Three describe blocks:
 *   A. Skip when persisted complete — body counter stays 0, no events fire,
 *      output equals persisted output (string / object / undefined)
 *   B. Re-run when persisted is non-complete — failed / suspended / running /
 *      pending all re-execute the body normally
 *   C. No prior persisted record — fresh snapshot runs the body normally
 */

import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { ChannelEvent } from "../channels";
import type { StepSnapshot } from "../snapshot";

import { Step } from "../step";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const seedComplete = (
  name: string,
  output: unknown
): Record<string, StepSnapshot> => ({
  [name]: {
    attempt: 1,
    completedAt: new Date().toISOString(),
    durationMs: 0,
    name,
    namespace: "",
    output,
    startedAt: new Date().toISOString(),
    status: "complete",
  },
});

const seedWithStatus = (
  name: string,
  status: StepSnapshot["status"]
): Record<string, StepSnapshot> => ({
  [name]: {
    attempt: 1,
    name,
    namespace: "",
    status,
  },
});

/**
 * Subscribe to channel events and return counters for `step.started` and
 * `step.complete` plus a `stop()` to interrupt the underlying fiber.
 */
function countLifecycle(step: Step): {
  readonly started: () => number;
  readonly complete: () => number;
  stop(): void;
} {
  let startedCount = 0;
  let completeCount = 0;
  const fiber = Effect.runFork(
    Stream.runForEach(step.channels.events.stream, (e: ChannelEvent) =>
      Effect.sync(() => {
        if (e._tag === "step.started") {
          startedCount++;
        }
        if (e._tag === "step.complete") {
          completeCount++;
        }
      })
    )
  );
  return {
    complete: () => completeCount,
    started: () => startedCount,
    stop: () => {
      Effect.runFork(fiber.interruptAsFork(fiber.id()));
    },
  };
}

const seed = (
  step: Step,
  records: Record<string, StepSnapshot>
): Promise<void> => Effect.runPromise(step.snapshot.seed(records));

// ════════════════════════════════════════════════════════════════════════════
// A. Skip when persisted complete
// ════════════════════════════════════════════════════════════════════════════

describe("step.run skip-on-complete — persisted complete", () => {
  it("returns persisted string output without invoking body or firing events", async () => {
    let calls = 0;
    const step = await Step.make<unknown, unknown>({
      execute: async () => {
        calls++;
        return "fresh";
      },
      input: undefined,
      name: "skipme",
    });
    const counts = countLifecycle(step);
    await sleep(5);
    await seed(step, seedComplete("skipme", "persisted-value"));
    const result = await step.run();
    await sleep(20);
    counts.stop();
    expect(result).toBe("persisted-value");
    expect(calls).toBe(0);
    expect(counts.started()).toBe(0);
    expect(counts.complete()).toBe(0);
  });

  it("returns persisted object output verbatim", async () => {
    let calls = 0;
    const step = await Step.make<unknown, unknown>({
      execute: async () => {
        calls++;
        return { a: 0, b: "fresh" };
      },
      input: undefined,
      name: "skipobj",
    });
    await seed(step, seedComplete("skipobj", { a: 99, b: "stored" }));
    const result = await step.run();
    expect(result).toEqual({ a: 99, b: "stored" });
    expect(calls).toBe(0);
  });

  it("returns undefined when persisted output is undefined", async () => {
    let calls = 0;
    const step = await Step.make<unknown, unknown>({
      execute: async () => {
        calls++;
      },
      input: undefined,
      name: "skipvoid",
    });
    await seed(step, seedComplete("skipvoid", undefined));
    await step.run();
    expect(step.output).toBeUndefined();
    expect(calls).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. Re-run when persisted is non-complete
// ════════════════════════════════════════════════════════════════════════════

describe("step.run skip-on-complete — non-complete persisted re-runs", () => {
  it("persisted status='failed' re-invokes the body and fires events", async () => {
    let calls = 0;
    const step = await Step.make<unknown, unknown>({
      execute: async () => {
        calls++;
        return "ok";
      },
      input: undefined,
      name: "rerun-failed",
    });
    const counts = countLifecycle(step);
    await sleep(5);
    await seed(step, seedWithStatus("rerun-failed", "failed"));
    const result = await step.run();
    await sleep(20);
    counts.stop();
    expect(result).toBe("ok");
    expect(calls).toBe(1);
    expect(counts.started()).toBe(1);
    expect(counts.complete()).toBe(1);
  });

  it("persisted status='suspended' re-invokes the body", async () => {
    let calls = 0;
    const step = await Step.make<unknown, unknown>({
      execute: async () => {
        calls++;
        return "ok";
      },
      input: undefined,
      name: "rerun-susp",
    });
    await seed(step, seedWithStatus("rerun-susp", "suspended"));
    const result = await step.run();
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("persisted status='running' (mid-run crash) re-invokes the body", async () => {
    let calls = 0;
    const step = await Step.make<unknown, unknown>({
      execute: async () => {
        calls++;
        return "ok";
      },
      input: undefined,
      name: "rerun-running",
    });
    await seed(step, seedWithStatus("rerun-running", "running"));
    const result = await step.run();
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("persisted status='pending' re-invokes the body", async () => {
    let calls = 0;
    const step = await Step.make<unknown, unknown>({
      execute: async () => {
        calls++;
        return "ok";
      },
      input: undefined,
      name: "rerun-pending",
    });
    await seed(step, seedWithStatus("rerun-pending", "pending"));
    const result = await step.run();
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. No prior persisted record
// ════════════════════════════════════════════════════════════════════════════

describe("step.run skip-on-complete — no prior persisted record", () => {
  it("fresh snapshot runs the body and fires events normally", async () => {
    let calls = 0;
    const step = await Step.make<unknown, unknown>({
      execute: async () => {
        calls++;
        return "ok";
      },
      input: undefined,
      name: "fresh",
    });
    const counts = countLifecycle(step);
    await sleep(5);
    const result = await step.run();
    await sleep(20);
    counts.stop();
    expect(result).toBe("ok");
    expect(calls).toBe(1);
    expect(counts.started()).toBe(1);
    expect(counts.complete()).toBe(1);
  });
});
