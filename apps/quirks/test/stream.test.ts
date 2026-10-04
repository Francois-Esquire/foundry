import { ArtifactSystem, InMemoryArtifactStore } from "@foundry/artifacts";
import { step } from "@foundry/quirks";
import type { ChannelMessage } from "@foundry/workflows/channels";
import { afterEach, describe, expect, it } from "vitest";
import { catalog } from "~/lib/catalog";
import { createEngine } from "~/lib/create";
import { runs } from "~/lib/run-scope";

afterEach(() => {
  catalog.reset();
  runs.clear();
});

describe("stream", () => {
  it("streams text and data from a step body to run subscribers", async () => {
    const engine = createEngine({
      artifacts: new ArtifactSystem({ store: new InMemoryArtifactStore() }),
      catalog,
      dry: true,
      only: [],
      print: () => undefined,
      root: process.cwd(),
      workspaceId: "ws",
    });
    step("counting").do(async ({ stream: output }) => {
      output.write("one ");
      await output.pipe(
        (async function* () {
          yield "two ";
          yield { done: true };
        })()
      );
      return "counted";
    });

    await engine.start();
    const launched = await engine.launch<string>("counting", {});
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
    await engine.dispose();
  });
});
