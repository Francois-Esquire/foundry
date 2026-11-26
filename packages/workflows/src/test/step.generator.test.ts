import { describe, expect, it } from "vitest";

import type { ChunkPayload } from "../slices/channels";

import { Step, StepBailError } from "../step";
import { bail } from "../types";

async function takePayloads(
  step: Step,
  count: number
): Promise<ChunkPayload[]> {
  const reader = step.stream.getReader();
  const payloads: ChunkPayload[] = [];
  for (let i = 0; i < count; i += 1) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    payloads.push(value);
  }
  reader.releaseLock();
  return payloads;
}

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

describe("generator body — implicit return", () => {
  it("yields once, no explicit return — step.output is undefined", async () => {
    const step = await Step.make<unknown, unknown>({
      async *execute() {
        yield "only";
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
    expect(step.status).toBe("failed");
  });
});

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

describe("generator body — abort mid-yield runs finally blocks", () => {
  it("try/finally around repeated yields — abort between yields trips iter.return(); finally runs", async () => {
    const flags = { finallyRan: false };

    const step = await Step.make<void, "done">({
      async *execute() {
        try {
          for (;;) {
            yield "tick";
            await new Promise<void>((r) => setTimeout(r, 1));
          }
        } finally {
          flags.finallyRan = true;
        }
      },
      input: undefined,
      name: "gen-abort-finally",
    });

    const reader = step.stream.getReader();
    const drained = (async () => {
      for (let i = 0; i < 3; i += 1) {
        const { done } = await reader.read();
        if (done) {
          break;
        }
      }
      reader.releaseLock();
    })();

    const runPromise = step.run().catch((err: unknown) => err);
    await new Promise<void>((r) => setTimeout(r, 20));
    step.abort("test-abort");
    const result = await runPromise;
    await drained.catch(() => undefined);
    expect(flags.finallyRan).toBe(true);
    expect(result).toBeInstanceOf(Error);
  });
});

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
    expect(yPayloads).toEqual(wPayloads);
    expect(yPayloads).toEqual([{ kind: "text", text: "hello" }]);
  });
});
