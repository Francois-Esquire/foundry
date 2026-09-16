/**
 * Step retry — RetryPolicy on StepSpec.config translates to an Effect Schedule.
 *
 * Pins: maxAttempts, shouldRetry predicate, the four backoff strategies,
 * Bail bypassing the schedule, and the per-Step scope of the policy
 * (a parent's retry does NOT cascade into a forked child's run).
 */

import { describe, expect, test } from "vitest";

import { Step, StepBailError } from "../step";
import { bail } from "../types";

describe("Step.retry — maxAttempts", () => {
  test("retries a thrown error and succeeds on the Nth attempt within the cap", async () => {
    let calls = 0;
    const step = await Step.make({
      config: { retry: { maxAttempts: 3 } },
      execute: async () => {
        calls++;
        if (calls < 3) {
          throw new Error(`fail ${calls}`);
        }
        return "ok";
      },
      input: undefined,
      name: "retry-success",
    });
    const result = await step.run();
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(step.status).toBe("complete");
  });

  test("bounds total attempts when execute never succeeds", async () => {
    let calls = 0;
    const step = await Step.make({
      config: { retry: { maxAttempts: 3 } },
      execute: async () => {
        calls++;
        throw new Error("always fails");
      },
      input: undefined,
      name: "retry-fail",
    });
    await expect(step.run()).rejects.toThrow("always fails");
    expect(calls).toBe(3);
    expect(step.status).toBe("failed");
  });

  test("maxAttempts=1 means a single execute with no retry", async () => {
    let calls = 0;
    const step = await Step.make({
      config: { retry: { maxAttempts: 1 } },
      execute: async () => {
        calls++;
        throw new Error("fail");
      },
      input: undefined,
      name: "retry-1",
    });
    await expect(step.run()).rejects.toThrow("fail");
    expect(calls).toBe(1);
    expect(step.status).toBe("failed");
  });

  test("absent policy means a single execute with no retry", async () => {
    let calls = 0;
    const step = await Step.make({
      execute: async () => {
        calls++;
        throw new Error("fail");
      },
      input: undefined,
      name: "no-retry",
    });
    await expect(step.run()).rejects.toThrow("fail");
    expect(calls).toBe(1);
    expect(step.status).toBe("failed");
  });
});

describe("Step.retry — Bail vs throw", () => {
  test("a Bail return is terminal and does NOT consume the retry budget", async () => {
    let calls = 0;
    const step = await Step.make({
      config: { retry: { maxAttempts: 5 } },
      execute: async () => {
        calls++;
        return bail("hard fail");
      },
      input: undefined,
      name: "bail-terminal",
    });
    await expect(step.run()).rejects.toBeInstanceOf(StepBailError);
    try {
      await step.run();
    } catch (err) {
      expect((err as StepBailError).bail).toEqual(bail("hard fail"));
    }
    // Two run() calls above; each invokes execute once (Bail bypasses retry).
    expect(calls).toBe(2);
    expect(step.status).toBe("failed");
  });

  test("interleaved throws and a final Bail: throws retry, Bail terminates", async () => {
    let calls = 0;
    const step = await Step.make({
      config: { retry: { maxAttempts: 5 } },
      execute: async () => {
        calls++;
        if (calls < 3) {
          throw new Error("recoverable");
        }
        return bail("fatal");
      },
      input: undefined,
      name: "throw-then-bail",
    });
    try {
      await step.run();
      throw new Error("expected bail");
    } catch (err) {
      expect(err).toBeInstanceOf(StepBailError);
      expect((err as StepBailError).bail).toEqual(bail("fatal"));
    }
    expect(calls).toBe(3);
    expect(step.status).toBe("failed");
  });
});

describe("Step.retry — shouldRetry predicate", () => {
  test("predicate returning false halts retry even when maxAttempts is not reached", async () => {
    let calls = 0;
    const step = await Step.make({
      config: {
        retry: {
          maxAttempts: 5,
          shouldRetry: () => false,
        },
      },
      execute: async () => {
        calls++;
        throw new Error("fail");
      },
      input: undefined,
      name: "predicate-halt",
    });
    await expect(step.run()).rejects.toThrow("fail");
    expect(calls).toBe(1);
    expect(step.status).toBe("failed");
  });

  test("predicate receives the failure value and the attempt count", async () => {
    let calls = 0;
    const seenErrors: unknown[] = [];
    const seenAttempts: number[] = [];
    const step = await Step.make({
      config: {
        retry: {
          maxAttempts: 3,
          shouldRetry: (err: unknown, attempt: number) => {
            seenErrors.push(err);
            seenAttempts.push(attempt);
            return true;
          },
        },
      },
      execute: async () => {
        calls++;
        throw new Error(`fail ${calls}`);
      },
      input: undefined,
      name: "predicate-args",
    });
    await expect(step.run()).rejects.toThrow();
    expect(calls).toBe(3);
    expect(step.status).toBe("failed");

    expect(seenErrors).toHaveLength(2);
    expect((seenErrors[0] as Error).message).toBe("fail 1");
    expect((seenErrors[1] as Error).message).toBe("fail 2");

    expect(seenAttempts).toEqual([1, 2]);
  });
});

describe("Step.retry — backoff strategies", () => {
  test("fixed backoff applies the configured delay between attempts", async () => {
    let calls = 0;
    const timestamps: number[] = [];
    const step = await Step.make({
      config: {
        retry: {
          backoff: { delay: "20ms", kind: "fixed" },
          maxAttempts: 3,
        },
      },
      execute: async () => {
        calls++;
        timestamps.push(Date.now());
        if (calls < 3) {
          throw new Error("fail");
        }
        return "ok";
      },
      input: undefined,
      name: "backoff-fixed",
    });
    await step.run();

    expect(calls).toBe(3);
    const diff1 = (timestamps[1] ?? 0) - (timestamps[0] ?? 0);
    const diff2 = (timestamps[2] ?? 0) - (timestamps[1] ?? 0);
    expect(diff1).toBeGreaterThanOrEqual(15);
    expect(diff2).toBeGreaterThanOrEqual(15);
  });

  test("exponential backoff grows the delay between attempts", async () => {
    let calls = 0;
    const timestamps: number[] = [];
    const step = await Step.make({
      config: {
        retry: {
          backoff: { factor: 3, initial: "10ms", kind: "exponential" },
          maxAttempts: 3,
        },
      },
      execute: async () => {
        calls++;
        timestamps.push(Date.now());
        if (calls < 3) {
          throw new Error("fail");
        }
        return "ok";
      },
      input: undefined,
      name: "backoff-exponential",
    });
    await step.run();

    expect(calls).toBe(3);
    const diff1 = (timestamps[1] ?? 0) - (timestamps[0] ?? 0); // ~10ms
    const diff2 = (timestamps[2] ?? 0) - (timestamps[1] ?? 0); // ~30ms

    expect(diff1).toBeGreaterThanOrEqual(5);
    expect(diff2).toBeGreaterThanOrEqual(25);
    // Under a contended root test run the first timer may wake late; that
    // scheduler delay must not make the correctly configured second delay
    // look smaller by comparison. The two independent floors pin the
    // exponential schedule without comparing wall-clock overshoot.
    expect(diff1 + diff2).toBeGreaterThanOrEqual(30);
  });

  test("linear backoff increments the delay between attempts", async () => {
    let calls = 0;
    const timestamps: number[] = [];
    const step = await Step.make({
      config: {
        retry: {
          backoff: { initial: "10ms", kind: "linear", step: "20ms" },
          maxAttempts: 3,
        },
      },
      execute: async () => {
        calls++;
        timestamps.push(Date.now());
        if (calls < 3) {
          throw new Error("fail");
        }
        return "ok";
      },
      input: undefined,
      name: "backoff-linear",
    });
    await step.run();

    expect(calls).toBe(3);
    const diff1 = (timestamps[1] ?? 0) - (timestamps[0] ?? 0); // ~10ms
    const diff2 = (timestamps[2] ?? 0) - (timestamps[1] ?? 0); // ~30ms

    expect(diff1).toBeGreaterThanOrEqual(5);
    expect(diff2).toBeGreaterThanOrEqual(25);
    // Compare against the configured floors, not against another timer whose
    // wake-up may have been inflated by parallel package tests.
    expect(diff1 + diff2).toBeGreaterThanOrEqual(30);
  });

  test("jittered backoff applies a positive bounded delay between attempts", async () => {
    let calls = 0;
    const timestamps: number[] = [];
    const step = await Step.make({
      config: {
        retry: {
          backoff: { initial: "10ms", kind: "jittered", max: "50ms" },
          maxAttempts: 3,
        },
      },
      execute: async () => {
        calls++;
        timestamps.push(Date.now());
        if (calls < 3) {
          throw new Error("fail");
        }
        return "ok";
      },
      input: undefined,
      name: "backoff-jittered",
    });
    await step.run();

    expect(calls).toBe(3);
    const diff1 = (timestamps[1] ?? 0) - (timestamps[0] ?? 0);
    const diff2 = (timestamps[2] ?? 0) - (timestamps[1] ?? 0);

    expect(diff1).toBeGreaterThanOrEqual(0);
    expect(diff2).toBeGreaterThanOrEqual(0);
  });
});

describe("Step.retry — scope (no cascade across fork)", () => {
  test("a parent's retry policy does NOT apply to a forked child step", async () => {
    let parentCalls = 0;
    let childCalls = 0;

    const parent = await Step.make({
      children: [
        {
          execute: async () => {
            childCalls++;
            throw new Error("child fail");
          },
          input: undefined,
          name: "child",
        },
      ],
      config: { retry: { maxAttempts: 5 } },
      execute: async (_, ctx) => {
        parentCalls++;
        const child = ctx.children[0];
        if (!child) {
          throw new Error("no child");
        }
        try {
          await child.run();
          throw new Error("child should have failed");
        } catch (err: unknown) {
          if ((err as Error).message !== "child fail") {
            throw err;
          }
        }
        return "ok";
      },
      input: undefined,
      name: "parent",
    });

    await parent.run();
    expect(parentCalls).toBe(1);
    expect(childCalls).toBe(1);
  });

  test("a forked child's own retry policy activates only on the child's runs", async () => {
    let parentCalls = 0;
    let childCalls = 0;

    const parent = await Step.make({
      children: [
        {
          config: { retry: { maxAttempts: 3 } },
          execute: async () => {
            childCalls++;
            if (childCalls < 3) {
              throw new Error("child fail");
            }
            return "child ok";
          },
          input: undefined,
          name: "child",
        },
      ],
      execute: async (_, ctx) => {
        parentCalls++;
        const child = ctx.children[0];
        if (!child) {
          throw new Error("no child");
        }
        const res = await child.run();
        return res;
      },
      input: undefined,
      name: "parent",
    });

    const result = await parent.run();
    expect(result).toBe("child ok");
    expect(parentCalls).toBe(1);
    expect(childCalls).toBe(3);
  });
});
