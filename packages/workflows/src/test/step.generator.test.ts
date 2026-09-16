/**
 * Step — async-generator body shape (pass 5b).
 *
 * `execute` may be `async function* (input, ctx) { yield x; ... return v }`.
 * Routing rules:
 *
 *   - Every `yield X` flows through `ctx.write(X)` — string → text chunk,
 *     `undefined`/`null` → no-op, anything else → JSON-checked data chunk.
 *   - The generator's `return X` becomes the step's `O` (or `Bail<unknown>`).
 *   - `throw` propagates through the driver; the existing `tapError` in
 *     `Step.#run` publishes `step.failed`. `try/finally` blocks run on
 *     abort because the driver calls `iter.return()`.
 *   - `ctx.write` AND `yield` are interchangeable — same envelope shape.
 *   - `await ctx.next()` works the same as in async-fn bodies.
 */

import { describe, expect, it } from "vitest";

import type { ChunkPayload } from "../channels";

import { Step, StepBailError } from "../step";
import { bail } from "../types";

/**
 * Pre-subscribe and resolve once `count` chunks have been collected.
 * Race-free — reader acquired before any write fires. Same shape used
 * by step.write.test.ts.
 */
async function takePayloads(
  step: Step,
  count: number
): Promise<ChunkPayload[]> {
  const reader = step.stream.getReader();
  const payloads: ChunkPayload[] = [];
  for (let i = 0; i < count; i++) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    payloads.push(value);
  }
  reader.releaseLock();
  return payloads;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Yields stream as chunks; return becomes output
// ════════════════════════════════════════════════════════════════════════════

describe("generator body — yields stream, return becomes output", () => {
  it("yields three strings, returns object — chunks land as text in order; output is the return value", async () => {
    const step = await Step.make<unknown, unknown>({
      async *execute() {
        yield "a";
        yield "b";
        yield "c";
        return { ok: true };
      },
      input: undefined,
      name: "gen-basic",
    });
    const collected = takePayloads(step, 3);
    const output = await step.run();
    const payloads = await collected;
    expect(payloads).toEqual([
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
      { kind: "text", text: "c" },
    ]);
    expect(output).toEqual({ ok: true });
    expect(step.output).toEqual({ ok: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Mixed yield types route through ctx.write
// ════════════════════════════════════════════════════════════════════════════

describe("generator body — mixed yield types route through ctx.write", () => {
  it("yields cover string/object/number/undefined/null/boolean — undefined and null are no-ops", async () => {
    const step = await Step.make<unknown, unknown>({
      async *execute() {
        yield "string";
        yield { x: 1 };
        yield 42;
        yield;
        yield null;
        yield true;
        return "ok";
      },
      input: undefined,
      name: "gen-mixed",
    });
    // 4 chunks expected (string, object, number, boolean) — undefined/null
    // produce no chunk.
    const collected = takePayloads(step, 4);
    await step.run();
    const payloads = await collected;
    expect(payloads).toEqual([
      { kind: "text", text: "string" },
      { data: { x: 1 }, kind: "data" },
      { data: 42, kind: "data" },
      { data: true, kind: "data" },
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. No return → output is undefined
// ════════════════════════════════════════════════════════════════════════════

describe("generator body — implicit return", () => {
  it("yields once, no explicit return — step.output is undefined", async () => {
    const step = await Step.make<unknown, unknown>({
      async *execute() {
        yield "only";
        // no return statement
      },
      input: undefined,
      name: "gen-no-return",
    });
    const collected = takePayloads(step, 1);
    await step.run();
    const payloads = await collected;
    expect(payloads).toEqual([{ kind: "text", text: "only" }]);
    expect(step.output).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. ctx.next() inside generator drains declared children mid-body
// ════════════════════════════════════════════════════════════════════════════

describe("generator body — await ctx.next() drains children mid-stream", () => {
  it("yield 'before', await ctx.next(), yield 'after' — child runs between yields", async () => {
    const order: string[] = [];

    const step = await Step.make<unknown, unknown>({
      children: [
        {
          execute: async () => {
            order.push("child");
            return "child-out";
          },
          input: undefined,
          name: "child",
        },
      ],
      async *execute(_input, ctx) {
        order.push("before");
        yield "before";
        await ctx.next();
        order.push("after");
        yield "after";
        return "done";
      },
      input: undefined,
      name: "gen-next",
    });
    const collected = takePayloads(step, 2);
    const output = await step.run();
    const payloads = await collected;
    expect(order).toEqual(["before", "child", "after"]);
    expect(payloads).toEqual([
      { kind: "text", text: "before" },
      { kind: "text", text: "after" },
    ]);
    expect(output).toBe("done");
    expect(step.steps["gen-next.child"]?.status).toBe("complete");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. return Bail.of(...) → StepBailError on step.run; step.failed semantics
// ════════════════════════════════════════════════════════════════════════════

describe("generator body — return Bail propagates through step.run", () => {
  it("yields once, returns Bail — step.run rejects with StepBailError; status is 'failed'", async () => {
    const step = await Step.make<unknown, unknown>({
      async *execute() {
        yield "before-bail";
        return bail("nope");
      },
      input: undefined,
      name: "gen-bail",
    });
    const collected = takePayloads(step, 1);
    let captured: unknown = "<<NOT-CAUGHT>>";
    try {
      await step.run();
    } catch (e) {
      captured = e;
    }
    const payloads = await collected;
    expect(payloads).toEqual([{ kind: "text", text: "before-bail" }]);
    expect(captured).toBeInstanceOf(StepBailError);
    expect((captured as StepBailError).bail.error).toBe("nope");
    // Bail projects status to "failed" (see snapshot.ts step.bailed handler).
    expect(step.status).toBe("failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. throw inside generator → step.failed
// ════════════════════════════════════════════════════════════════════════════

describe("generator body — throw publishes step.failed", () => {
  it("yields once then throws — step.run rejects with the original Error; status is 'failed'", async () => {
    const step = await Step.make<unknown, unknown>({
      async *execute() {
        yield "before-throw";
        throw new Error("inner-boom");
      },
      input: undefined,
      name: "gen-throw",
    });
    const collected = takePayloads(step, 1);
    let captured: unknown = "<<NOT-CAUGHT>>";
    try {
      await step.run();
    } catch (e) {
      captured = e;
    }
    const payloads = await collected;
    expect(payloads).toEqual([{ kind: "text", text: "before-throw" }]);
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("inner-boom");
    expect(step.status).toBe("failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. try/finally cleanup runs when step is aborted mid-yield
// ════════════════════════════════════════════════════════════════════════════

describe("generator body — abort mid-yield runs finally blocks", () => {
  it("try/finally around repeated yields — abort between yields trips iter.return(); finally runs", async () => {
    const flags = { finallyRan: false };

    const step = await Step.make<void, "done">({
      async *execute() {
        try {
          // Yield in a loop. Each iter.next() resumes the body to the
          // next yield. The driver's pre-iter abort check fires on the
          // iteration after step.abort() is called from outside, calling
          // iter.return() — which runs the `finally` block below before
          // the body has a chance to issue another yield.
          while (true) {
            yield "tick";
            // Macrotask gap — lets the test's setTimeout-driven abort
            // land on the event loop. A microtask gap (Promise.resolve)
            // would starve setTimeout and the abort never fires.
            await new Promise<void>((r) => setTimeout(r, 1));
          }
        } finally {
          flags.finallyRan = true;
        }
      },
      input: undefined,
      name: "gen-abort-finally",
    });

    // Pre-subscribe so we don't race the chunk pump. We don't actually
    // care how many ticks landed — just drain a few off the stream so
    // the run gets at least one yield through.
    const reader = step.stream.getReader();
    const drained = (async () => {
      // Read up to a few payloads, then release.
      for (let i = 0; i < 3; i++) {
        const { done } = await reader.read();
        if (done) {
          break;
        }
      }
      reader.releaseLock();
    })();

    const runPromise = step.run().catch((err: unknown) => err);
    // Wait long enough for several yields to flow.
    await new Promise<void>((r) => setTimeout(r, 20));
    step.abort("test-abort");
    const result = await runPromise;
    await drained.catch(() => undefined);
    expect(flags.finallyRan).toBe(true);
    // The runtime surfaces an Error when the driver sees signal.aborted.
    expect(result).toBeInstanceOf(Error);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. ctx.write and yield produce equivalent chunks
// ════════════════════════════════════════════════════════════════════════════

describe("generator body — yield equivalence with ctx.write", () => {
  it("a yield-string body and a ctx.write-string body produce identical envelopes (modulo timestamp)", async () => {
    const yielder = await Step.make<unknown, unknown>({
      async *execute() {
        yield "hello";
        return "ok";
      },
      input: undefined,
      name: "gen-yielder",
    });
    const writer = await Step.make<unknown, unknown>({
      execute: async (_input, ctx) => {
        ctx.write("hello");
        return "ok";
      },
      input: undefined,
      name: "gen-writer",
    });
    const collectY = takePayloads(yielder, 1);
    const collectW = takePayloads(writer, 1);
    await yielder.run();
    await writer.run();
    const yPayloads = await collectY;
    const wPayloads = await collectW;
    // Payload-only stream: ChunkPayload is the value envelope, no timestamp.
    expect(yPayloads).toEqual(wPayloads);
    expect(yPayloads).toEqual([{ kind: "text", text: "hello" }]);
  });
});
