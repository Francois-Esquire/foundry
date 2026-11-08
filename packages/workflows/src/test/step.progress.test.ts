import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Step } from "../step";
import { bail } from "../types";

const STEP_PROGRESS_MUST_BE_IN_PATTERN = /step\.progress must be in \[0, 100\]/;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Pre-subscribe to progress emissions for a step's path and resolve once
 * `count` values have arrived, so immediate writes are captured.
 */
function takeProgress(step: Step, count: number): Promise<number[]> {
  return Effect.runPromise(
    step.channels
      .progressFor(step.path)
      .pipe(Stream.take(count), Stream.runCollect)
      .pipe(Effect.map((c) => [...c]))
  );
}

describe("step.progress — getter defaults", () => {
  it("is 0 immediately after Step.make (no setter ever called)", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    expect(step.progress).toBe(0);
  });
});

describe("step.progress — setter happy path", () => {
  it("setting 0/50/100 updates the getter synchronously", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    step.progress = 0;
    expect(step.progress).toBe(0);
    step.progress = 50;
    expect(step.progress).toBe(50);
    step.progress = 100;
    expect(step.progress).toBe(100);
  });

  it("multiple sequential sets each take effect", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    step.progress = 25;
    expect(step.progress).toBe(25);
    step.progress = 75;
    expect(step.progress).toBe(75);
    step.progress = 100;
    expect(step.progress).toBe(100);
  });

  it("setting the same value still works (no equality short-circuit)", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    step.progress = 33;
    expect(step.progress).toBe(33);
    step.progress = 33;
    expect(step.progress).toBe(33);
  });
});

describe("step.progress — setter validation", () => {
  it("throws RangeError on -1", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    expect(() => {
      step.progress = -1;
    }).toThrow(RangeError);
    expect(() => {
      step.progress = -1;
    }).toThrow(STEP_PROGRESS_MUST_BE_IN_PATTERN);
  });

  it("throws RangeError on 101", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    expect(() => {
      step.progress = 101;
    }).toThrow(RangeError);
  });

  it("throws RangeError on NaN", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    expect(() => {
      step.progress = Number.NaN;
    }).toThrow(RangeError);
  });

  it("throws RangeError on a string (typeof guard)", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    expect(() => {
      step.progress = "50" as unknown as number;
    }).toThrow(RangeError);
  });

  it("throws RangeError on Infinity", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    expect(() => {
      step.progress = Number.POSITIVE_INFINITY;
    }).toThrow(RangeError);
  });
});

describe("step.progress — no-op when terminal", () => {
  it("no-op after the step completes (auto-100 stays 100)", async () => {
    const step = await Step.make({
      execute: async () => "ok",
      input: undefined,
      name: "x",
    });
    await step.run();
    expect(step.isTerminal).toBe(true);
    expect(step.progress).toBe(100);
    step.progress = 25;
    expect(step.progress).toBe(100);
  });

  it("no-op after step.skip() (progress stays at the pre-skip value)", async () => {
    const step = await Step.make({
      execute: async () => "should not run",
      input: undefined,
      name: "x",
    });
    step.skip();
    expect(step.status).toBe("skipped");
    expect(step.progress).toBe(0);
    step.progress = 50;
    expect(step.progress).toBe(0);
  });

  it("no-op after step.abort() on a non-terminal step", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    step.abort();
    expect(step.status).toBe("aborted");
    expect(step.progress).toBe(0);
    step.progress = 75;
    expect(step.progress).toBe(0);
  });
});

describe("step.progressChanges — Stream projection", () => {
  it("collects [25, 50, 75] in order via pre-subscribed take(3)", async () => {
    const step = await Step.make<unknown, unknown>({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    const collected = takeProgress(step, 3);
    await sleep(5);
    step.progress = 25;
    step.progress = 50;
    step.progress = 75;
    expect(await collected).toEqual([25, 50, 75]);
  });

  it("does not emit when other event types fire (e.g. step.pause)", async () => {
    const step = await Step.make<unknown, unknown>({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    const collected = takeProgress(step, 1);
    await sleep(5);
    step.pause();
    await sleep(10);
    step.resume();
    await sleep(10);
    step.progress = 42;
    expect(await collected).toEqual([42]);
  });
});

describe("step.progress — auto-100 on success", () => {
  it("a successful step has progress === 100 after invoke", async () => {
    const step = await Step.make({
      execute: async () => "ok",
      input: undefined,
      name: "x",
    });
    await step.run();
    expect(step.progress).toBe(100);
  });

  it("progressChanges emits 100 on completion (subscribe before invoke)", async () => {
    const step = await Step.make<unknown, unknown>({
      execute: async () => "ok",
      input: undefined,
      name: "x",
    });
    const collected = takeProgress(step, 1);
    await sleep(5);
    await step.run();
    expect(await collected).toEqual([100]);
  });

  it("does NOT auto-set when the step throws (last-set value preserved)", async () => {
    const stepHolder: { current: Step | undefined } = { current: undefined };
    const step = await Step.make<unknown, unknown>({
      execute: async () => {
        const { current } = stepHolder;
        if (!current) {
          throw new Error("stepRef not initialized");
        }
        current.progress = 60;
        throw new Error("kaboom");
      },
      input: undefined,
      name: "x",
    });
    stepHolder.current = step;
    await step.run().catch(() => undefined);
    expect(step.status).toBe("failed");
    expect(step.progress).toBe(60);
  });

  it("does NOT auto-set when the step bails (last-set value preserved)", async () => {
    const stepHolder: { current: Step | undefined } = { current: undefined };
    const step = await Step.make<unknown, unknown>({
      execute: async () => {
        const { current } = stepHolder;
        if (!current) {
          throw new Error("stepRef not initialized");
        }
        current.progress = 40;
        return bail({ reason: "policy" });
      },
      input: undefined,
      name: "x",
    });
    stepHolder.current = step;
    await step.run().catch(() => undefined);
    expect(step.status).toBe("failed");
    expect(step.progress).toBe(40);
  });

  it("does NOT auto-set on a pre-skipped step (progress stays 0)", async () => {
    const step = await Step.make({
      execute: async () => "should not run",
      input: undefined,
      name: "x",
    });
    step.skip();
    await step.run();
    expect(step.status).toBe("skipped");
    expect(step.progress).toBe(0);
  });
});
