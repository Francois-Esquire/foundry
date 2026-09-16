/**
 * Step — chunk-publishing seam (channels surface).
 *
 * Consolidates `step.write.test.ts`, `step.streaming.test.ts`, and
 * `step.chunks.test.ts`. The seam in question:
 *
 *   - `step.write(value)` and `ctx.write(value)` route to the same
 *     chunk push (string → text, `null`/`undefined` → no-op, else →
 *     data; non-JSON-serializable throws TypeError).
 *   - `step.emit(type, payload)` lands on the events channel, not chunks.
 *   - `step.channels.chunks.stream` carries `ChannelChunk` envelopes
 *     (with `stepId` + ISO `at`); `step.stream` is the public
 *     value-only `ReadableStream<ChunkPayload>`.
 *   - Cross-step filtering: `step.stream` and `channels.chunksFor(name)`
 *     see only the named step's chunks. `step.stream` closes on abort.
 *   - Failures interleave: chunks before a thrown body propagate; writes
 *     after abort never throw.
 *
 * Generator-yield ↔ ctx.write equivalence lives in `step.generator.test.ts`.
 */

import { describe, expect, it } from "vitest";

import type { ChunkPayload } from "../channels";

import { Step } from "../step";
import { collectChunks, collectEvents, takePayloads } from "./helpers/streams";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const makeWriter = (name = "alpha"): Promise<Step> =>
  Step.make<unknown, unknown>({
    execute: async () => undefined,
    input: undefined,
    name,
  });

// ════════════════════════════════════════════════════════════════════════════
// A. write(text) / write(data) delivery + envelope
// ════════════════════════════════════════════════════════════════════════════

describe("Step.write — chunk delivery + envelope shape", () => {
  it("text write produces an envelope tagged with stepId + ISO `at` and payload.kind=text", async () => {
    const step = await makeWriter();
    const sink = collectChunks(step, { take: 1 });
    await sleep(5);
    const before = Date.now();
    step.write("hello");
    await sleep(20);
    sink.stop();
    expect(sink.chunks).toHaveLength(1);
    const envelope = sink.chunks[0];
    expect(envelope?.stepId).toBe(step.name);
    expect(envelope?.payload).toEqual({ kind: "text", text: "hello" });
    expect(typeof envelope?.at).toBe("string");
    expect(envelope?.at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    const parsed = envelope ? new Date(envelope.at).getTime() : Number.NaN;
    expect(parsed).toBeGreaterThanOrEqual(before);
  });

  it("data write produces payload.kind=data with the value deeply equal", async () => {
    const step = await makeWriter();
    const sink = collectChunks(step, { take: 1 });
    await sleep(5);
    const data = { x: 1, y: [2, 3], z: { nested: true } };
    step.write(data);
    await sleep(20);
    sink.stop();
    const envelope = sink.chunks[0];
    expect(envelope?.stepId).toBe(step.name);
    expect(envelope?.payload).toEqual({ data, kind: "data" });
  });

  it.each([
    ["", { kind: "text", text: "" }],
    [42, { data: 42, kind: "data" }],
    [true, { data: true, kind: "data" }],
    [[1, 2, 3], { data: [1, 2, 3], kind: "data" }],
    [{ ok: true }, { data: { ok: true }, kind: "data" }],
  ] as const)("value %p routes to payload %p", async (value, expected) => {
    const step = await makeWriter();
    const sink = collectChunks(step, { take: 1 });
    await sleep(5);
    step.write(value);
    await sleep(20);
    sink.stop();
    expect(sink.chunks[0]?.payload).toEqual(expected);
  });

  it.each([undefined, null])(
    "%p is a no-op (missing values aren't persisted)",
    async (value) => {
      const step = await Step.make<unknown, unknown>({
        execute: async (_input, ctx) => {
          ctx.write(value);
          ctx.write("after-noop");
          return "ok";
        },
        input: undefined,
        name: "noop",
      });
      const collected = takePayloads(step, 1);
      await step.run();
      const payloads = await collected;
      // Only the second write should appear; the first was a no-op.
      expect(payloads).toEqual([{ kind: "text", text: "after-noop" }]);
    }
  );
});

// ════════════════════════════════════════════════════════════════════════════
// B. step.write (outer) parity with ctx.write (body)
// ════════════════════════════════════════════════════════════════════════════

describe("Step.write — outer/body parity + ordering", () => {
  it("step.write outside the body produces the same envelope as ctx.write inside", async () => {
    const step = await makeWriter("parity");
    const collected = takePayloads(step, 1);
    step.write("from outside");
    const payloads = await collected;
    expect(payloads).toEqual([{ kind: "text", text: "from outside" }]);
  });

  it("multiple ctx.write calls land in publish order", async () => {
    const step = await Step.make<unknown, unknown>({
      execute: async (_input, ctx) => {
        ctx.write("first");
        ctx.write({ n: 2 });
        ctx.write("third");
        ctx.write([4]);
        return "ok";
      },
      input: undefined,
      name: "order",
    });
    const collected = takePayloads(step, 4);
    await step.run();
    expect(await collected).toEqual([
      { kind: "text", text: "first" },
      { data: { n: 2 }, kind: "data" },
      { kind: "text", text: "third" },
      { data: [4], kind: "data" },
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. assertSerializable guard — non-JSON values throw TypeError
// ════════════════════════════════════════════════════════════════════════════

describe("Step.write — assertSerializable guard", () => {
  it("ctx.write(bigint) throws TypeError synchronously inside the body", async () => {
    const errors: unknown[] = [];
    const step = await Step.make<unknown, unknown>({
      execute: async (_input, ctx) => {
        try {
          ctx.write(42n);
        } catch (err) {
          errors.push(err);
        }
        return "ok";
      },
      input: undefined,
      name: "write-bigint",
    });
    await step.run();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TypeError);
  });

  it("step.write(circular) throws TypeError naming the call site", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "write-circular",
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => {
      step.write(circular);
    }).toThrow(TypeError);
    expect(() => {
      step.write(circular);
    }).toThrow(/write-circular\.write/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D. step.stream — value-only ReadableStream<ChunkPayload>
// ════════════════════════════════════════════════════════════════════════════

describe("Step.stream — value-only ReadableStream<ChunkPayload>", () => {
  it("reads payloads (no envelope) in publish order — payload.kind exists, stepId does not", async () => {
    const stepHolder: { current: Step | undefined } = { current: undefined };
    const step = await Step.make<unknown, unknown>({
      execute: async () => {
        stepHolder.current?.write("hello");
        stepHolder.current?.write({ x: 1 });
      },
      input: undefined,
      name: "alpha",
    });
    stepHolder.current = step;

    const reader = step.stream.getReader();
    await step.run();
    const first = await reader.read();
    const second = await reader.read();
    reader.releaseLock();
    void step.stream.cancel();

    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect(first.value).toEqual({ kind: "text", text: "hello" });
    expect(second.value).toEqual({ data: { x: 1 }, kind: "data" });
    const asUnknown = first.value as unknown as Record<string, unknown>;
    expect(asUnknown.stepId).toBeUndefined();
  });

  it("a switch on payload.kind narrows to each branch shape", async () => {
    const describePayload = (payload: ChunkPayload): string => {
      switch (payload.kind) {
        case "text":
          return payload.text;
        case "data":
          return JSON.stringify(payload.data);
      }
    };

    const step = await makeWriter("switcher");
    const sink = collectChunks(step, { take: 2 });
    await sleep(5);
    step.write("hello");
    step.write({ n: 1 });
    await sleep(20);
    sink.stop();
    const described = sink.chunks.map((e) => describePayload(e.payload));
    expect(described).toEqual(["hello", '{"n":1}']);
  });

  it("the next read after step.abort() resolves with done:true", async () => {
    const step = await makeWriter();
    const reader = step.stream.getReader();
    step.abort();
    const result = await reader.read();
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
    reader.releaseLock();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// E. Cross-step filtering — child.stream + channels.chunksFor(name)
// ════════════════════════════════════════════════════════════════════════════

describe("Cross-step chunk filtering", () => {
  it("child.stream sees only the child's chunks", async () => {
    const parent = await Step.make<void, void>({
      children: [
        {
          execute: async () => undefined,
          input: undefined,
          name: "child",
        },
      ],
      execute: async () => undefined,
      input: undefined,
      name: "parent",
    });
    const child = parent.children[0];
    if (!child) {
      throw new Error("expected one child");
    }

    const reader = child.stream.getReader();
    parent.write("from-parent");
    child.write("from-child-1");
    parent.write("more-from-parent");
    child.write("from-child-2");
    await sleep(10);
    const a = await reader.read();
    const b = await reader.read();
    reader.releaseLock();
    void child.stream.cancel();

    expect(a.done).toBe(false);
    expect(b.done).toBe(false);
    if (a.value?.kind === "text") {
      expect(a.value.text).toBe("from-child-1");
    }
    if (b.value?.kind === "text") {
      expect(b.value.text).toBe("from-child-2");
    }
  });

  it("channels.chunksFor(name) sees only that step's chunks", async () => {
    const parent = await Step.make<void, void>({
      children: [
        {
          execute: async () => undefined,
          input: undefined,
          name: "child",
        },
      ],
      execute: async () => undefined,
      input: undefined,
      name: "parent",
    });
    const child = parent.children[0];
    if (!child) {
      throw new Error("expected one child");
    }

    const stream = parent.channels.chunksFor(parent.name);
    const reader = stream.getReader();
    child.write("ignored");
    parent.write("seen-1");
    child.write("ignored-2");
    parent.write("seen-2");
    await sleep(10);
    const a = await reader.read();
    const b = await reader.read();
    reader.releaseLock();
    void stream.cancel();

    expect(a.done).toBe(false);
    expect(b.done).toBe(false);
    if (a.value?.kind === "text") {
      expect(a.value.text).toBe("seen-1");
    }
    if (b.value?.kind === "text") {
      expect(b.value.text).toBe("seen-2");
    }
  });

  it("concurrent siblings preserve per-producer publish order on the parent's chunks channel", async () => {
    const parent = await Step.make({
      children: [
        { execute: async () => undefined, input: undefined, name: "a" },
        { execute: async () => undefined, input: undefined, name: "b" },
      ],
      execute: async () => undefined,
      input: undefined,
      name: "fanout",
    });
    const [a, b] = parent.children;
    if (!(a && b)) {
      throw new Error("expected children");
    }

    const sink = collectChunks(parent);
    await sleep(5);
    a.write("a1");
    b.write("b1");
    a.write("a2");
    b.write("b2");
    a.write("a3");
    b.write("b3");
    await sleep(20);
    sink.stop();

    const fromA = sink.chunks
      .filter((c) => c.stepId === "a" && c.payload.kind === "text")
      .map((c) => (c.payload.kind === "text" ? c.payload.text : ""));
    const fromB = sink.chunks
      .filter((c) => c.stepId === "b" && c.payload.kind === "text")
      .map((c) => (c.payload.kind === "text" ? c.payload.text : ""));
    expect(fromA).toEqual(["a1", "a2", "a3"]);
    expect(fromB).toEqual(["b1", "b2", "b3"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F. emit — typed events distinct from chunks
// ════════════════════════════════════════════════════════════════════════════

describe("Step.emit — typed events distinct from chunks", () => {
  it("step.emit(type, payload) lands on Channels.events as a 'custom' event, not chunks", async () => {
    const step = await makeWriter("emitter");
    const events = collectEvents(step);
    const chunks = collectChunks(step);
    await sleep(5);
    step.emit("checkpoint", { step: 1 });
    await sleep(20);
    events.stop();
    chunks.stop();

    const customs = events.events.filter((e) => e._tag === "custom");
    expect(customs).toHaveLength(1);
    if (customs[0]?._tag === "custom") {
      expect(customs[0].type).toBe("checkpoint");
      expect(customs[0].payload).toEqual({ step: 1 });
      expect(customs[0].stepId).toBe("emitter");
    }
    expect(chunks.chunks).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G. Failure interleaving + post-abort writes
// ════════════════════════════════════════════════════════════════════════════

describe("Failure interleaving + post-abort", () => {
  it("chunks written before a thrown body propagate; the run still ends 'failed'", async () => {
    const step = await Step.make({
      execute: async (_input, ctx) => {
        ctx.write("before-fail-1");
        ctx.write("before-fail-2");
        throw new Error("kaboom");
      },
      input: undefined,
      name: "failing",
    });
    const sink = collectChunks(step);
    await sleep(5);
    await step.run().catch(() => undefined);
    await sleep(20);
    sink.stop();

    const seen = sink.chunks
      .filter((c) => c.payload.kind === "text")
      .map((c) => (c.payload.kind === "text" ? c.payload.text : ""));
    expect(seen).toEqual(["before-fail-1", "before-fail-2"]);
    expect(step.status).toBe("failed");
  });

  it("writes after abort() are best-effort: they never throw", async () => {
    // PubSub.unbounded keeps accepting writes after publish; pin only the
    // no-throw guarantee. Whether subscribers see the post-abort write is
    // environment-dependent and not part of the contract.
    const step = await makeWriter("post-abort");
    step.abort("done");
    expect(() => {
      step.write("after-abort");
    }).not.toThrow();
    expect(() => {
      step.write({ n: 1 });
    }).not.toThrow();
  });
});
