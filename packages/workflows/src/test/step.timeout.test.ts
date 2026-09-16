/**
 * Step timeout — StepSpec.config.timeout enforces a per-invocation budget
 * via Effect.timeoutFail in Step.run().
 */

import { describe, expect, test } from "vitest";

import { Step } from "../step";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════════
// Duration parsing
// ════════════════════════════════════════════════════════════════════════════

describe("Step.timeout — duration parsing", () => {
  test("numeric ms accepted (e.g. 30 → 30ms)", async () => {
    const step = await Step.make({
      config: { timeout: 30 },
      execute: async () => {
        await sleep(150);
        return "late";
      },
      input: undefined,
      name: "num-ms",
    });
    await expect(step.run()).rejects.toThrow(/timed out after 30/);
    expect(step.status).toBe("failed");
  });

  test("string durations accepted (e.g. '5s', '500ms', '2m')", async () => {
    const fast = await Step.make({
      config: { timeout: "20ms" },
      execute: async () => {
        await sleep(150);
        return "late";
      },
      input: undefined,
      name: "str-ms",
    });
    await expect(fast.run()).rejects.toThrow(/timed out after 20ms/);
    expect(fast.status).toBe("failed");

    // '5s' / '2m' are valid syntactically — exercise via a step that
    // completes immediately so the budget is irrelevant. The test is
    // about parsing acceptance, not enforcement.
    const seconds = await Step.make({
      config: { timeout: "5s" },
      execute: async () => "ok",
      input: undefined,
      name: "secs",
    });
    await expect(seconds.run()).resolves.toBe("ok");

    const minutes = await Step.make({
      config: { timeout: "2m" },
      execute: async () => "ok",
      input: undefined,
      name: "mins",
    });
    await expect(minutes.run()).resolves.toBe("ok");
  });

  test("an unparseable duration string surfaces as a typed run failure (not a defect)", async () => {
    const step = await Step.make({
      config: { timeout: "5seconds" },
      execute: async () => "ok",
      input: undefined,
      name: "bad-duration",
    });
    await expect(step.run()).rejects.toThrow(/Unparseable duration: 5seconds/);
    expect(step.status).toBe("failed");
  });

  test("an invalid duration short-circuits before execute is invoked", async () => {
    let calls = 0;
    const step = await Step.make({
      config: { timeout: "potato" },
      execute: async () => {
        calls++;
        return "should not run";
      },
      input: undefined,
      name: "bad-pre-execute",
    });
    await step.run().catch(() => undefined);
    expect(calls).toBe(0);
    expect(step.status).toBe("failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Enforcement on a leaf step
// ════════════════════════════════════════════════════════════════════════════

describe("Step.timeout — enforcement on a leaf step", () => {
  test("a step exceeding its budget fails with a TimeoutError", async () => {
    const step = await Step.make({
      config: { timeout: 20 },
      execute: async () => {
        await sleep(200);
        return "late";
      },
      input: undefined,
      name: "exceed",
    });
    await expect(step.run()).rejects.toThrow(/timed out/);
    expect(step.status).toBe("failed");
  });

  test("the TimeoutError message references the step name and the budget", async () => {
    const step = await Step.make({
      config: { timeout: "25ms" },
      execute: async () => {
        await sleep(200);
        return "late";
      },
      input: undefined,
      name: "named-budget",
    });
    await expect(step.run()).rejects.toThrow(
      /Step "named-budget" timed out after 25ms/
    );
  });

  test("a step finishing within the budget completes normally", async () => {
    const step = await Step.make<void, "ok">({
      config: { timeout: 200 },
      execute: async (): Promise<"ok"> => {
        await sleep(10);
        return "ok";
      },
      input: undefined,
      name: "in-budget",
    });
    const result = await step.run();
    expect(result).toBe("ok");
    expect(step.status).toBe("complete");
  });

  test("a tight budget (1ms) reliably fires for a slow step", async () => {
    const step = await Step.make({
      config: { timeout: 1 },
      execute: async () => {
        await sleep(50);
        return "late";
      },
      input: undefined,
      name: "tight",
    });
    await expect(step.run()).rejects.toThrow(/timed out/);
    expect(step.status).toBe("failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Interaction with retry
// ════════════════════════════════════════════════════════════════════════════

describe("Step.timeout — interaction with retry", () => {
  test("each retry attempt gets its own fresh timeout budget", async () => {
    let calls = 0;
    const start = Date.now();
    const step = await Step.make<void, "ok" | "late">({
      config: {
        retry: {
          backoff: { delay: "1ms", kind: "fixed" },
          maxAttempts: 3,
        },
        timeout: 30,
      },
      execute: async () => {
        calls++;
        if (calls < 3) {
          // First two attempts blow the budget.
          await sleep(150);
          return "late";
        }
        // Third attempt finishes inside the budget.
        return "ok";
      },
      input: undefined,
      name: "retry-budget",
    });
    const result = await step.run();
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    // If the budget were shared across attempts, the third attempt would
    // never get a chance to run. Sanity floor: at least two timed-out
    // budgets elapsed before success.
    expect(Date.now() - start).toBeGreaterThanOrEqual(60);
  });

  test("a step that always exceeds the budget is retried up to maxAttempts then fails", async () => {
    let calls = 0;
    const step = await Step.make({
      config: {
        retry: {
          backoff: { delay: "1ms", kind: "fixed" },
          maxAttempts: 3,
        },
        timeout: 15,
      },
      execute: async () => {
        calls++;
        await sleep(120);
        return "late";
      },
      input: undefined,
      name: "always-slow",
    });
    await expect(step.run()).rejects.toThrow(/timed out/);
    expect(calls).toBe(3);
    expect(step.status).toBe("failed");
  });

  test("shouldRetry receives the TimeoutError and may opt out of retry", async () => {
    let calls = 0;
    const observed: string[] = [];
    const step = await Step.make({
      config: {
        retry: {
          backoff: { delay: "1ms", kind: "fixed" },
          maxAttempts: 5,
          shouldRetry: (err) => {
            observed.push(err instanceof Error ? err.message : String(err));
            // Opt out the moment we see a timeout.
            return err instanceof Error
              ? !err.message.includes("timed out")
              : true;
          },
        },
        timeout: 15,
      },
      execute: async () => {
        calls++;
        await sleep(120);
        return "late";
      },
      input: undefined,
      name: "opt-out",
    });
    await expect(step.run()).rejects.toThrow(/timed out/);
    // shouldRetry sees the timeout error on the first attempt and bails out;
    // exactly one execute call (no retries).
    expect(calls).toBe(1);
    expect(observed.length).toBeGreaterThanOrEqual(1);
    expect(observed.some((m) => m.includes("timed out"))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Snapshot record
// ════════════════════════════════════════════════════════════════════════════

describe("Step.timeout — snapshot record", () => {
  test("the timed-out step's snapshot record carries status=failed with the timeout error shape", async () => {
    const step = await Step.make({
      config: { timeout: 15 },
      execute: async () => {
        await sleep(150);
        return "late";
      },
      input: undefined,
      name: "snap",
    });
    await step.run().catch(() => undefined);
    await sleep(10);
    const state = step.state;
    const record = state.steps.snap;
    expect(record?.status).toBe("failed");
    expect(record?.error?.message).toMatch(/Step "snap" timed out after 15/);
    expect(record?.output).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Distinct from cancellation
// ════════════════════════════════════════════════════════════════════════════

describe("Step.timeout — distinct from cancellation", () => {
  test("internal timeout abort surfaces as failed with TimeoutError, NOT cancelled", async () => {
    const step = await Step.make({
      config: { timeout: 15 },
      execute: async () => {
        await sleep(150);
        return "late";
      },
      input: undefined,
      name: "timeout-not-cancel",
    });
    await step.run().catch(() => undefined);
    await sleep(10);
    expect(step.status).toBe("failed");
    expect(step.aborted).toBe(false);
    const state = step.state;
    expect(state.steps["timeout-not-cancel"]?.status).toBe("failed");
  });

  test("an external abort with reason surfaces as cancelled with the user reason", async () => {
    const stepHolder: { current: Step<void, void> | undefined } = {
      current: undefined,
    };
    const step = await Step.make<void, void>({
      // Generous budget so the external abort wins.
      config: { timeout: "5s" },
      execute: () =>
        new Promise<void>((_resolve, reject) => {
          const s = stepHolder.current;
          if (!s) {
            reject(new Error("stepRef not initialized"));
            return;
          }
          if (s.signal.aborted) {
            reject(new Error("AbortError"));
            return;
          }
          s.signal.addEventListener(
            "abort",
            () => {
              reject(new Error("AbortError"));
            },
            { once: true }
          );
        }),
      input: undefined,
      name: "external-abort",
    });
    stepHolder.current = step;
    const settled = step.run();
    await sleep(10);
    step.abort("user-cancelled");
    await settled.catch(() => undefined);
    await sleep(10);
    expect(step.status).toBe("aborted");
    expect(step.aborted).toBe(true);
    expect(step.reason).toBe("user-cancelled");
  });
});
