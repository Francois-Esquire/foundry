/**
 * Step execution — error propagation, child fan-out, mixed outcomes.
 *
 * Retry & timeout policy live in step.retry.test.ts and step.timeout.test.ts.
 * This file focuses on what happens when execute does or doesn't return cleanly,
 * and how those outcomes flow through forked child steps.
 */

import { describe, expect, it } from "vitest";
import { isStepBailError, Step, StepBailError } from "../step";
import type { Bail } from "../types";
import { bail, isBail } from "../types";

/**
 * Drive a step and capture either its successful output or — when the
 * body returned `bail(...)` — the surfaced Bail value (instead of letting
 * `step.run()` throw `StepBailError`). Mirrors the pre-rewrite
 * `Effect.either(step.#run())` pattern at the JS seam.
 */
async function runWithBail<O>(step: Step<unknown, O>): Promise<unknown> {
  try {
    return await step.run();
  } catch (e) {
    if (isStepBailError(e)) {
      return e.bail;
    }
    throw e;
  }
}

describe("Step execution — error propagation", () => {
  it("a thrown Error surfaces as a rejection with the original message", async () => {
    const step = await Step.make<void, never>({
      execute: async () => {
        throw new Error("boom");
      },
      input: undefined,
      name: "thrower",
    });
    await expect(step.run()).rejects.toThrow("boom");
  });

  it("a non-Error throw is wrapped (rejection carries an Error instance)", async () => {
    const step = await Step.make<void, never>({
      execute: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- test fixture: asserts non-Error throws are wrapped
        throw "literal";
      },
      input: undefined,
      name: "string-thrower",
    });
    await expect(step.run()).rejects.toThrow("literal");
    await expect(step.run()).rejects.toBeInstanceOf(Error);
  });

  it("an asynchronous rejection inside execute behaves the same as a sync throw", async () => {
    const step = await Step.make<void, never>({
      execute: async () => {
        await Promise.resolve();
        return Promise.reject(new Error("async-bad"));
      },
      input: undefined,
      name: "rejector",
    });
    await expect(step.run()).rejects.toThrow("async-bad");
  });
});

describe("Step execution — child fan-out via fork", () => {
  it("parent.fork(spec) returns a Step whose path is parent.path + [child.name]", async () => {
    const parent = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "p",
    });
    const child = parent.fork({
      execute: async () => undefined,
      input: undefined,
      name: "c",
    });
    expect(child.path).toEqual(["p", "c"]);
  });

  it("multiple forked children execute independently in parallel", async () => {
    const order: string[] = [];
    const parent = await Step.make<void, readonly string[]>({
      children: [
        {
          execute: async () => {
            await new Promise((r) => setTimeout(r, 30));
            order.push("a");
            return "a";
          },
          input: undefined,
          name: "a",
        },
        {
          execute: async () => {
            await new Promise((r) => setTimeout(r, 5));
            order.push("b");
            return "b";
          },
          input: undefined,
          name: "b",
        },
      ],
      execute: async (_input, ctx) =>
        Promise.all(ctx.children.map((c) => c.run() as Promise<string>)),
      input: undefined,
      name: "fanout",
    });
    const result = await parent.run();
    expect(result).toEqual(["a", "b"]);
    expect(order).toEqual(["b", "a"]);
  });

  it("one child failing does not interrupt sibling children by default", async () => {
    const completed: string[] = [];
    const parent = await Step.make<
      void,
      readonly PromiseSettledResult<unknown>[]
    >({
      children: [
        {
          execute: async () => {
            await new Promise((r) => setTimeout(r, 10));
            completed.push("ok");
            return "ok";
          },
          input: undefined,
          name: "ok",
        },
        {
          execute: async () => {
            throw new Error("nope");
          },
          input: undefined,
          name: "fail",
        },
      ],
      execute: async (_input, ctx) =>
        Promise.allSettled(ctx.children.map((c) => c.run())),
      input: undefined,
      name: "p",
    });
    await parent.run();
    expect(completed).toContain("ok");
  });

  it("parent that awaits all children fails when any awaited child fails", async () => {
    const parent = await Step.make<void, never>({
      children: [
        {
          execute: async () => {
            throw new Error("child-fail");
          },
          input: undefined,
          name: "fail",
        },
      ],
      execute: async (_input, ctx) => {
        await Promise.all(ctx.children.map((c) => c.run()));
        return undefined as never;
      },
      input: undefined,
      name: "p",
    });
    await expect(parent.run()).rejects.toThrow(/child-fail/);
  });
});

describe("Step execution — mixed success/failure", () => {
  it("parent that catches a failed child can still return a value", async () => {
    const parent = await Step.make<void, string>({
      children: [
        {
          execute: async () => {
            throw new Error("ignored");
          },
          input: undefined,
          name: "fail",
        },
      ],
      execute: async (_input, ctx) => {
        try {
          await ctx.children[0]?.run();
          return "unreachable";
        } catch {
          return "recovered";
        }
      },
      input: undefined,
      name: "p",
    });
    const result = await parent.run();
    expect(result).toBe("recovered");
  });

  it("parent that re-throws a failed child propagates the original error", async () => {
    const parent = await Step.make<void, never>({
      children: [
        {
          execute: async () => {
            throw new Error("original");
          },
          input: undefined,
          name: "fail",
        },
      ],
      execute: async (_input, ctx) => {
        await ctx.children[0]?.run();
        return undefined as never;
      },
      input: undefined,
      name: "p",
    });
    await expect(parent.run()).rejects.toThrow(/original/);
  });
});

describe("Bail vs throw — distinct semantics", () => {
  it("execute returning bail(error) throws StepBailError carrying the Bail value", async () => {
    const step = await Step.make<unknown, Bail<string>>({
      execute: async () => bail("forbidden"),
      input: undefined,
      name: "bailer",
    });
    const result = await runWithBail(step);
    expect(isBail(result)).toBe(true);
    await expect(step.run()).rejects.toBeInstanceOf(StepBailError);
  });

  it("isBail() distinguishes a Bail return from a successful value", () => {
    expect(isBail("ok")).toBe(false);
    expect(isBail(bail("err"))).toBe(true);
  });

  it("bail short-circuits without consuming retry budget (single attempt)", async () => {
    let attempts = 0;
    const step = await Step.make<unknown, Bail<string>>({
      config: {
        retry: { maxAttempts: 5 },
      },
      execute: async () => {
        attempts++;
        return bail("nope");
      },
      input: undefined,
      name: "bailer",
    });
    await runWithBail(step);
    expect(attempts).toBe(1);
  });

  it("bail propagates upward to a parent without being wrapped in an Error", async () => {
    const captured: { fromChild?: unknown } = {};
    const parent = await Step.make<void, void>({
      children: [
        {
          execute: async () => bail({ code: 42 }),
          input: undefined,
          name: "bailer",
        },
      ],
      execute: async (_input, ctx) => {
        const child = ctx.children[0];
        if (!child) {
          return;
        }
        const result = await child.run().catch((e: unknown) => {
          if (isStepBailError(e)) {
            return e.bail;
          }
          throw e;
        });
        captured.fromChild = result;
      },
      input: undefined,
      name: "p",
    });
    await parent.run();
    expect(isBail(captured.fromChild)).toBe(true);
    expect((captured.fromChild as { error: { code: number } }).error.code).toBe(
      42
    );
  });

  it("a thrown Error and a bailed value are observably different to the parent", async () => {
    const captured: { fromBail?: unknown; fromThrow?: unknown } = {};
    const parent = await Step.make<void, void>({
      children: [
        {
          execute: async () => bail("bailed"),
          input: undefined,
          name: "bailer",
        },
        {
          execute: async () => {
            throw new Error("thrown");
          },
          input: undefined,
          name: "thrower",
        },
      ],
      execute: async (_input, ctx) => {
        const [b, t] = ctx.children;
        if (b) {
          captured.fromBail = await b.run().catch((e: unknown) => {
            if (isStepBailError(e)) {
              return e.bail;
            }
            throw e;
          });
        }
        if (t) {
          try {
            await t.run();
          } catch (e) {
            captured.fromThrow = e;
          }
        }
      },
      input: undefined,
      name: "p",
    });
    await parent.run();
    expect(isBail(captured.fromBail)).toBe(true);
    expect(captured.fromThrow).toBeInstanceOf(Error);
    expect((captured.fromThrow as Error).message).toBe("thrown");
  });
});
