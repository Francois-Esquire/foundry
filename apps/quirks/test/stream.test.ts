import { step } from "@foundry/quirks";
import type { ChannelMessage } from "@foundry/workflows/channels";
import { afterEach, describe, expect, it } from "vitest";

import { startEngine } from "~/engine";
import { registry } from "~/lib/registry";
import { bindRuntime } from "~/runtime";

const OUTSIDE_STEP = /inside a running step/;

afterEach(() => {
  registry.reset();
});

describe("stream primitive", () => {
  it("streams text and data from a step body to run subscribers", async () => {
    const runtime = bindRuntime({
      dry: true,
      only: [],
      print: () => undefined,
      root: process.cwd(),
    });
    registry.bind(runtime.primitives);
    const counting = step("counting", async ({ stream: output }) => {
      output.write("one ");
      await output.pipe(
        (async function* () {
          yield "two ";
          yield { done: true };
        })()
      );
      return "counted";
    });

    const engine = await startEngine(
      (orchestrator) => {
        orchestrator.register("counting", counting.factory());
      },
      { print: () => undefined }
    );
    const launched = await engine.launch<string>("counting", undefined);
    const stream = engine.stream(launched.id);
    if (!stream) {
      throw new Error("expected a live run stream");
    }
    const messages: ChannelMessage[] = [];
    const reading = (async () => {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        messages.push(value);
        if (value._tag === "event" && value.event._tag === "step.complete") {
          await reader.cancel();
          return;
        }
      }
    })();
    await expect(launched.result).resolves.toBe("counted");
    await reading;
    // Settled runs are no longer streamed by this process.
    expect(engine.stream(launched.id)).toBeUndefined();
    await engine.stop();

    const chunks = messages.flatMap((message) =>
      message._tag === "chunk" ? [message.chunk] : []
    );
    expect(chunks.map((chunk) => chunk.payload)).toEqual([
      { kind: "text", text: "one " },
      { kind: "text", text: "two " },
      { data: { done: true }, kind: "data" },
    ]);
    expect(chunks.every((chunk) => chunk.path.at(-1) === "counting")).toBe(
      true
    );
    await runtime.dispose();
  });

  it("refuses to write outside a step", async () => {
    const runtime = bindRuntime({
      dry: true,
      only: [],
      print: () => undefined,
      root: process.cwd(),
    });
    expect(() => runtime.primitives.stream.write("x")).toThrow(OUTSIDE_STEP);
    await expect(
      runtime.primitives.stream.pipe(new ReadableStream())
    ).rejects.toThrow(OUTSIDE_STEP);
    await runtime.dispose();
  });
});
