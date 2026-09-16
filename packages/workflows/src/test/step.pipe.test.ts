/**
 * Step.pipe — drain a `ReadableStream` or `AsyncIterable` into the step's
 * channel via `write`. The body-side seam (`ctx.pipe`) and the outside-
 * the-body seam (`step.pipe`) share an impl.
 *
 * Contract:
 *   - Each value is routed through `write` — same routing rules as direct
 *     calls. String → text, `undefined` / `null` → no-op, else → data.
 *   - `step.signal` aborts → pipe **resolves cleanly** (no throw); reader/
 *     iterator is cancelled as a belt-and-suspenders cleanup. The step
 *     itself lands `"aborted"` via the existing executable machinery.
 *   - Source throws (not abort) → pipe rejects with that error; if used
 *     inside a body and uncaught, the step lands `"failed"`.
 *   - Source ends naturally → pipe resolves; chunks land in publish order.
 *
 * Two sources, one impl. ReadableStream uses `reader.read()` + `cancel()`;
 * AsyncIterable uses `iter.next()` + `iter.return()`. Both are dispatched
 * inside `Step.pipe`.
 */

import { describe, expect, it } from "vitest";

import { Step } from "../step";
import { takePayloads } from "./helpers/streams";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Build a ReadableStream that emits `values` then closes. */
function streamOf<T>(values: readonly T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const v of values) {
        controller.enqueue(v);
      }
      controller.close();
    },
  });
}

/** Build an AsyncIterable that yields `values` then ends. */
async function* iterOf<T>(values: readonly T[]): AsyncGenerator<T, void> {
  for (const v of values) {
    await sleep(0);
    yield v;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ReadableStream sources
// ════════════════════════════════════════════════════════════════════════════

describe("step.pipe — ReadableStream source", () => {
  it("forwards each value through write in publish order", async () => {
    const step = await Step.make<unknown, unknown>({
      execute: async () => undefined,
      input: undefined,
      name: "rs-order",
    });
    const collected = takePayloads(step, 3);
    await step.pipe(streamOf(["a", "b", "c"]));
    const payloads = await collected;
    expect(payloads).toEqual([
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
      { kind: "text", text: "c" },
    ]);
  });

  it("data values from a ReadableStream become data chunks", async () => {
    const step = await Step.make<unknown, unknown>({
      execute: async () => undefined,
      input: undefined,
      name: "rs-data",
    });
    const collected = takePayloads(step, 2);
    await step.pipe(streamOf([{ x: 1 }, [1, 2]]));
    const payloads = await collected;
    expect(payloads).toEqual([
      { data: { x: 1 }, kind: "data" },
      { data: [1, 2], kind: "data" },
    ]);
  });

  it("empty ReadableStream resolves immediately and writes nothing", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "rs-empty",
    });
    let chunkCount = 0;
    const reader = step.stream.getReader();
    const drain = (async () => {
      while (true) {
        const { done } = await reader.read();
        if (done) {
          return;
        }
        chunkCount++;
      }
    })();

    await step.pipe(streamOf<string>([]));
    await sleep(5);
    void reader.cancel();
    await drain.catch(() => undefined);
    reader.releaseLock();
    expect(chunkCount).toBe(0);
  });

  it("source error rejects the pipe with the original error", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "rs-error",
    });
    const failing = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("ok-1");
        controller.error(new Error("boom"));
      },
    });
    let caught: unknown;
    try {
      await step.pipe(failing);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AsyncIterable sources
// ════════════════════════════════════════════════════════════════════════════

describe("step.pipe — AsyncIterable source", () => {
  it("forwards each yielded value through write in publish order", async () => {
    const step = await Step.make<unknown, unknown>({
      execute: async () => undefined,
      input: undefined,
      name: "ai-order",
    });
    const collected = takePayloads(step, 3);
    await step.pipe(iterOf(["one", "two", "three"]));
    const payloads = await collected;
    expect(payloads).toEqual([
      { kind: "text", text: "one" },
      { kind: "text", text: "two" },
      { kind: "text", text: "three" },
    ]);
  });

  it("a plain async generator works as a source (the Claude SDK shape)", async () => {
    interface SDKMessage {
      readonly text: string;
    }
    async function* fakeAgentSession(): AsyncGenerator<SDKMessage> {
      yield { text: "thinking…" };
      yield { text: "still thinking…" };
      yield { text: "done." };
    }
    const step = await Step.make<unknown, unknown>({
      execute: async () => undefined,
      input: undefined,
      name: "agent",
    });
    const collected = takePayloads(step, 3);
    await step.pipe(fakeAgentSession());
    const payloads = await collected;
    expect(payloads).toEqual([
      { data: { text: "thinking…" }, kind: "data" },
      { data: { text: "still thinking…" }, kind: "data" },
      { data: { text: "done." }, kind: "data" },
    ]);
  });

  it("source throw rejects the pipe with the original error", async () => {
    async function* throwing(): AsyncGenerator<string> {
      yield "ok-1";
      throw new Error("kaboom");
    }
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "ai-error",
    });
    let caught: unknown;
    try {
      await step.pipe(throwing());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("kaboom");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Abort semantics — pipe resolves cleanly on abort (decision 3)
// ════════════════════════════════════════════════════════════════════════════

describe("step.pipe — abort semantics", () => {
  it("pre-aborted step: pipe is a no-op and never reads from the source", async () => {
    let pulls = 0;
    async function* counted(): AsyncGenerator<string> {
      while (true) {
        pulls++;
        await sleep(1);
        yield "x";
      }
    }
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "pre-aborted",
    });
    step.abort("pre-pipe");
    await step.pipe(counted());
    expect(pulls).toBe(0);
  });

  it("mid-pipe abort resolves cleanly (no throw) and cancels the AsyncIterable", async () => {
    let returnCalled = false;
    async function* longRunning(): AsyncGenerator<string> {
      try {
        for (let i = 0; i < 1000; i++) {
          await sleep(2);
          yield `tick-${i}`;
        }
      } finally {
        returnCalled = true;
      }
    }
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "mid-abort-iter",
    });
    const piping = step.pipe(longRunning());
    await sleep(10);
    step.abort("done");
    // The contract: pipe resolves cleanly, no throw.
    await expect(piping).resolves.toBeUndefined();
    expect(returnCalled).toBe(true);
  });

  it("mid-pipe abort cancels a slow ReadableStream and resolves cleanly", async () => {
    let cancelled = false;
    const slowStream = new ReadableStream<string>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue("first");
        // never close; just sit there
      },
    });
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "mid-abort-rs",
    });
    const piping = step.pipe(slowStream);
    await sleep(10);
    step.abort("done");
    await expect(piping).resolves.toBeUndefined();
    await sleep(5);
    expect(cancelled).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ctx.pipe — body-side seam, same impl
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.pipe — body-side seam", () => {
  it("ctx.pipe inside an async-fn body forwards into step.stream", async () => {
    const step = await Step.make<unknown, unknown>({
      execute: async (_input, ctx) => {
        await ctx.pipe(iterOf(["a", "b"]));
        return "ok";
      },
      input: undefined,
      name: "ctx-pipe-body",
    });
    const collected = takePayloads(step, 2);
    await step.run();
    const payloads = await collected;
    expect(payloads).toEqual([
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
    ]);
  });

  it("ctx.pipe interleaves correctly with ctx.write — order preserved", async () => {
    const step = await Step.make<unknown, unknown>({
      execute: async (_input, ctx) => {
        ctx.write("before");
        await ctx.pipe(iterOf(["mid-1", "mid-2"]));
        ctx.write("after");
        return "ok";
      },
      input: undefined,
      name: "interleave",
    });
    const collected = takePayloads(step, 4);
    await step.run();
    const payloads = await collected;
    expect(payloads).toEqual([
      { kind: "text", text: "before" },
      { kind: "text", text: "mid-1" },
      { kind: "text", text: "mid-2" },
      { kind: "text", text: "after" },
    ]);
  });

  it("hand-off: ctx.signal passed to a source ends the source naturally on abort", async () => {
    let returned = false;
    function makeSession(signal: AbortSignal): AsyncGenerator<string> {
      return (async function* () {
        try {
          while (!signal.aborted) {
            await sleep(2);
            yield "tick";
          }
        } finally {
          returned = true;
        }
      })();
    }
    const step = await Step.make<void, void>({
      execute: async (_input, ctx) => {
        await ctx.pipe(makeSession(ctx.signal));
      },
      input: undefined,
      name: "handoff",
    });
    const settled = step.run();
    await sleep(10);
    step.abort("done");
    await expect(settled).resolves.toBeUndefined();
    expect(returned).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Routing parity — pipe values flow through write's existing rules
// ════════════════════════════════════════════════════════════════════════════

describe("step.pipe — routing rules match write", () => {
  it("undefined and null values are skipped, not persisted as chunks", async () => {
    const step = await Step.make<unknown, unknown>({
      execute: async () => undefined,
      input: undefined,
      name: "skip-nullish",
    });
    const collected = takePayloads(step, 1);
    await step.pipe(
      iterOf<string | null | undefined>(["only-this", null, undefined])
    );
    const payloads = await collected;
    expect(payloads).toEqual([{ kind: "text", text: "only-this" }]);
  });
});
