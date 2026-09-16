/**
 * Step pause / resume / skip — Stage 2 (P1-3 + P1-4).
 *
 * Five describe blocks:
 *   1. step.pause() — guards, idempotency, status flip
 *   2. step.resume() — restores running, no-op when not paused
 *   3. step.skip() — pre-execution gate, terminal transition
 *   4. step.run() respects pre-paused / pre-skipped state
 *   5. step.waitIfPaused() — cooperative body-side parking
 */

import { describe, expect, it } from "vitest";

import { Step } from "../step";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe("step.pause", () => {
  it("flips status to 'paused'", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    step.pause();
    expect(step.status).toBe("paused");
    expect(step.paused).toBe(true);
  });

  it("is idempotent — second pause is a no-op", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    step.pause();
    step.pause("again");
    expect(step.status).toBe("paused");
  });

  it("is a no-op on terminal steps", async () => {
    const step = await Step.make({
      execute: async () => "ok",
      input: undefined,
      name: "x",
    });
    await step.run();
    expect(step.isTerminal).toBe(true);
    step.pause();
    expect(step.status).toBe("complete");
  });
});

describe("step.resume", () => {
  it("transitions paused → running", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    step.pause();
    step.resume();
    expect(step.status).toBe("running");
    expect(step.paused).toBe(false);
  });

  it("is a no-op when not paused", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    expect(step.status).toBe("pending");
    step.resume();
    expect(step.status).toBe("pending");
  });
});

describe("step.skip", () => {
  it("transitions pending → skipped (terminal)", async () => {
    const step = await Step.make({
      execute: async () => "should not run",
      input: undefined,
      name: "x",
    });
    step.skip("not chosen");
    expect(step.status).toBe("skipped");
    expect(step.isTerminal).toBe(true);
  });

  it("throws if the step is not pending", async () => {
    const step = await Step.make({
      execute: async () => "ok",
      input: undefined,
      name: "x",
    });
    await step.run();
    expect(() => {
      step.skip();
    }).toThrow(/can only skip a pending step/);
  });
});

describe("step.run() honors pre-set state", () => {
  it("short-circuits a pre-skipped step (no execute call)", async () => {
    let calls = 0;
    const step = await Step.make({
      execute: async () => {
        calls++;
        return "should not run";
      },
      input: undefined,
      name: "x",
    });
    step.skip();
    const result = await step.run();
    expect(result).toBeUndefined();
    expect(calls).toBe(0);
    expect(step.status).toBe("skipped");
  });

  it("a pre-paused step parks the first attempt until resumed", async () => {
    let calls = 0;
    const step = await Step.make({
      execute: async () => {
        calls++;
        return "ok";
      },
      input: undefined,
      name: "x",
    });
    step.pause();
    // Give the SubscriptionRef listener fiber a tick to mirror the
    // 'paused' status onto the run-internal pause-check seam before
    // step.run() reads it.
    await sleep(10);
    const settled = step.run();
    // Race window: give the parked-attempt scheduler a chance to run if
    // it incorrectly fires the body. The body must NOT run while paused.
    await sleep(20);
    expect(calls).toBe(0);
    step.resume();
    const result = await settled;
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });
});

describe("step.waitIfPaused()", () => {
  it("returns immediately when not paused", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    await step.waitIfPaused();
  });

  it("parks while paused, resolves on resume", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    step.pause();
    // Give the SubscriptionRef listener fiber a tick to mirror the
    // 'paused' status before waitIfPaused() reads it.
    await sleep(10);
    let resolved = false;
    const waiting = step.waitIfPaused().then(() => {
      resolved = true;
    });
    // Race window: give the would-be resolver a chance to mistakenly fire
    // before resume(); the assertion is that it does NOT resolve.
    await sleep(20);
    expect(resolved).toBe(false);
    step.resume();
    await waiting;
    expect(resolved).toBe(true);
  });
});
