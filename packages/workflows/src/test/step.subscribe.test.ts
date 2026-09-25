/**
 * Run-level subscriptions and path-scoped chunks.
 *
 *   - `step.subscribe()` opens any number of streams over the run's events
 *     and chunks; each replays history, then follows live, then ends when
 *     the run's scope closes.
 *   - Chunks carry the writer's `path`, so two same-named steps under
 *     different parents do not mix their output in `step.stream`.
 */

import { describe, expect, it } from "vitest";

import type { ChannelMessage, ChunkPayload } from "../channels";
import type { StepContext } from "../step";

import { Step } from "../step";

interface StreamSource {
  readonly stream: ReadableStream<ChunkPayload>;
}

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const items: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return items;
    }
    items.push(value);
  }
}

function texts(messages: readonly ChannelMessage[]): string[] {
  return messages.flatMap((message) =>
    message._tag === "chunk" && message.chunk.payload.kind === "text"
      ? [`${message.chunk.path.join(".")}:${message.chunk.payload.text}`]
      : []
  );
}

/**
 * root → a → work and root → b → work, run concurrently so the two steps
 * named "work" are writing at the same time.
 */
async function twoWorkers(
  onWork?: (step: StreamSource, label: string) => void
): Promise<Step<undefined, string>> {
  const worker = (label: string) => ({
    execute: async (_input: undefined, ctx: StepContext<undefined, string>) => {
      onWork?.(ctx.step, label);
      ctx.write(`${label}-1`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      ctx.write(`${label}-2`);
      return label;
    },
    input: undefined,
    name: "work",
  });
  const parent = (label: string) => ({
    execute: async (_input: undefined, ctx: StepContext<undefined, string>) => {
      await ctx.fork(worker(label)).run();
      return label;
    },
    input: undefined,
    name: label,
  });
  return Step.make<undefined, string>({
    execute: async (_input, ctx) => {
      await Promise.all([
        ctx.fork(parent("a")).run(),
        ctx.fork(parent("b")).run(),
      ]);
      return "done";
    },
    input: undefined,
    name: "root",
  });
}

describe("Step.subscribe — replaying, multi-reader run streams", () => {
  it("gives every subscriber the whole run, including what happened before it attached", async () => {
    const root = await twoWorkers();
    const early = drain(root.subscribe());
    await root.run();
    const late = drain(root.subscribe());
    await root.dispose();
    const expected = [
      "root.a.work:a-1",
      "root.a.work:a-2",
      "root.b.work:b-1",
      "root.b.work:b-2",
    ];
    const seenEarly = texts(await early);
    expect([...seenEarly].sort()).toEqual(expected);
    // Both subscribers see the same run in the same order.
    expect(texts(await late)).toEqual(seenEarly);
    const events = (await early).flatMap((message) =>
      message._tag === "event" ? [message.event._tag] : []
    );
    expect(events).toContain("step.started");
    expect(events).toContain("step.complete");
  });

  it("ends a subscription early when its signal aborts", async () => {
    const root = await twoWorkers();
    const controller = new AbortController();
    controller.abort();
    const messages = await drain(root.subscribe(controller.signal));
    expect(messages).toEqual([]);
  });
});

describe("Step.stream — path-scoped chunks", () => {
  it("does not mix output from same-named steps under different parents", async () => {
    const seen: Promise<ChunkPayload[]>[] = [];
    const root = await twoWorkers((step, label) => {
      if (label === "a") {
        const reader = step.stream.getReader();
        seen.push(
          (async () => {
            const payloads: ChunkPayload[] = [];
            while (payloads.length < 2) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              payloads.push(value);
            }
            reader.releaseLock();
            return payloads;
          })()
        );
      }
    });
    await root.run();
    const [payloads] = await Promise.all(seen);
    expect(payloads).toEqual([
      { kind: "text", text: "a-1" },
      { kind: "text", text: "a-2" },
    ]);
  });
});
