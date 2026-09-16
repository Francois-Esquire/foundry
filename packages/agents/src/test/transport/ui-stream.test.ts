import type { UIMessage, UIMessageChunk } from "ai";

import { readUIMessageStream } from "ai";
import { describe, expect, test } from "vitest";

import type {
  SessionEvent,
  SessionMessage,
  SessionStream,
  SessionUsage,
} from "../../session";

import { projectToUIMessageChunks } from "../../transport";

const USAGE: SessionUsage = {
  inputTokens: 10,
  outputTokens: 4,
  totalTokens: 14,
};

/** Minimal SessionStream over a fixed event list; the projector only iterates. */
function streamOf(events: SessionEvent[]): SessionStream {
  return {
    // Async generator with nothing to await — it exists only to satisfy
    // SessionStream's AsyncIterable contract over a fixed in-memory list.
    // eslint-disable-next-line @typescript-eslint/require-await
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    message: Promise.resolve({} as SessionMessage),
    outcome: Promise.resolve("complete"),
    text: Promise.resolve(""),
    usage: Promise.resolve(USAGE),
  };
}

async function collect(stream: SessionStream, model?: string) {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of projectToUIMessageChunks(
    stream,
    model ? { model } : {}
  )) {
    chunks.push(chunk);
  }
  return chunks;
}

function types(chunks: UIMessageChunk[]): string[] {
  return chunks.map((c) => c.type);
}

/** Adapt the projector's async generator into the ReadableStream the SDK reads. */
function toReadable(
  gen: AsyncGenerator<UIMessageChunk>
): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      // Keep the IteratorResult intact so its `done` discriminant narrows
      // `value` to UIMessageChunk (destructuring would widen it to `any`).
      const result = await gen.next();
      if (result.done) {
        controller.close();
      } else {
        controller.enqueue(result.value);
      }
    },
  });
}

describe("projectToUIMessageChunks", () => {
  test("opens with a start chunk carrying the model metadata", async () => {
    const chunks = await collect(
      streamOf([
        { message: {} as SessionMessage, type: "finish", usage: USAGE },
      ]),
      "claude-sonnet-4-6"
    );
    expect(chunks[0]).toEqual({
      messageMetadata: { model: { id: "claude-sonnet-4-6" } },
      type: "start",
    });
  });

  test("frames a text run with start / delta / end", async () => {
    const chunks = await collect(
      streamOf([
        { delta: "Hel", type: "text-delta" },
        { delta: "lo", type: "text-delta" },
        { message: {} as SessionMessage, type: "finish", usage: USAGE },
      ])
    );
    expect(types(chunks)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
    // Both deltas share one text id.
    const start = chunks.find((c) => c.type === "text-start");
    const deltas = chunks.filter((c) => c.type === "text-delta");
    const id = start && "id" in start ? start.id : undefined;
    expect(deltas.every((d) => "id" in d && d.id === id)).toBe(true);
  });

  test("closes the text run before a tool call and maps call + result", async () => {
    const chunks = await collect(
      streamOf([
        { delta: "calling", type: "text-delta" },
        {
          input: { q: "x" },
          name: "recall",
          toolCallId: "c1",
          type: "tool-call",
        },
        { output: { hits: 2 }, toolCallId: "c1", type: "tool-result" },
        { message: {} as SessionMessage, type: "finish", usage: USAGE },
      ])
    );
    expect(types(chunks)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end", // run closed before the tool call
      "tool-input-available",
      "tool-output-available",
      "finish-step",
      "finish",
    ]);
    const call = chunks.find((c) => c.type === "tool-input-available");
    expect(call).toMatchObject({
      input: { q: "x" },
      toolCallId: "c1",
      toolName: "recall",
    });
  });

  test("maps an errored tool result to tool-output-error", async () => {
    const chunks = await collect(
      streamOf([
        { input: {}, name: "remember", toolCallId: "c1", type: "tool-call" },
        {
          isError: true,
          output: "nope",
          toolCallId: "c1",
          type: "tool-result",
        },
        { message: {} as SessionMessage, type: "finish", usage: USAGE },
      ])
    );
    const err = chunks.find((c) => c.type === "tool-output-error");
    expect(err).toMatchObject({ errorText: "nope", toolCallId: "c1" });
  });

  test("projects usage onto the SDK's nested shape in the finish metadata", async () => {
    const usage: SessionUsage = {
      cachedInputTokens: 6,
      cacheWriteTokens: 2,
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 3,
      totalTokens: 14,
    };
    const chunks = await collect(
      streamOf([{ message: {} as SessionMessage, type: "finish", usage }])
    );
    const finish = chunks.at(-1);
    // Cache/reasoning counts move under the nested detail objects (the current,
    // non-deprecated fields); cache-write only exists here.
    expect(finish).toEqual({
      messageMetadata: {
        usage: {
          inputTokenDetails: {
            cacheReadTokens: 6,
            cacheWriteTokens: 2,
            noCacheTokens: undefined,
          },
          inputTokens: 10,
          outputTokenDetails: {
            reasoningTokens: 3,
            textTokens: undefined,
          },
          outputTokens: 4,
          totalTokens: 14,
        },
      },
      type: "finish",
    });
  });

  test("output is accepted by the SDK's readUIMessageStream (text + tool)", async () => {
    const stream = streamOf([
      { delta: "Using a tool: ", type: "text-delta" },
      {
        input: { q: "x" },
        name: "recall",
        toolCallId: "c1",
        type: "tool-call",
      },
      { output: { hits: 2 }, toolCallId: "c1", type: "tool-result" },
      { delta: "done", type: "text-delta" },
      { message: {} as SessionMessage, type: "finish", usage: USAGE },
    ]);

    const errors: unknown[] = [];
    let final: UIMessage | undefined;
    for await (const message of readUIMessageStream({
      onError: (e) => errors.push(e),
      stream: toReadable(projectToUIMessageChunks(stream)),
    })) {
      final = message;
    }

    // The SDK reconstructed a coherent message from our chunks without error.
    expect(errors).toEqual([]);
    if (!final) {
      throw new Error("readUIMessageStream yielded no message");
    }

    const text = final.parts
      .filter((p) => p.type === "text")
      .map((p) => ("text" in p ? p.text : ""))
      .join("");
    expect(text).toBe("Using a tool: done");

    const toolPart = final.parts.find((p) => p.type.startsWith("tool-"));
    expect(toolPart).toBeDefined();
  });

  test("frames a reasoning run and switches cleanly to text", async () => {
    const chunks = await collect(
      streamOf([
        { delta: "hmm", type: "reasoning-delta" },
        { delta: "answer", type: "text-delta" },
        { message: {} as SessionMessage, type: "finish", usage: USAGE },
      ])
    );
    expect(types(chunks)).toEqual([
      "start",
      "start-step",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end", // closed when text begins
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
  });
});
