import { describe, expect, it } from "vitest";

import type { SessionHarness } from "../../harness";
import type {
  SessionInput,
  SessionMessage,
  SessionStream,
  SessionUsage,
  StreamOptions,
} from "../../session";

import {
  streamSessionAgent,
  toSessionInput,
  turnHasInput,
} from "../../transport";

const USAGE: SessionUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** A finished, empty SessionStream — the turn helper only iterates it. */
function emptyStream(): SessionStream {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- nothing to await
    async *[Symbol.asyncIterator]() {
      yield { message: {} as SessionMessage, type: "finish", usage: USAGE };
    },
    message: Promise.resolve({} as SessionMessage),
    outcome: Promise.resolve("complete"),
    text: Promise.resolve(""),
    usage: Promise.resolve(USAGE),
  };
}

/** A fake harness session that records the options each `stream` call receives. */
function recordingAgent(): {
  agent: SessionHarness;
  inputs: SessionInput[];
  calls: StreamOptions[];
} {
  const inputs: SessionInput[] = [];
  const calls: StreamOptions[] = [];
  // `streamSessionAgent` only calls `.stream`, so a minimal fake cast to the
  // class is enough — no need to construct a real harness.
  const agent = {
    stream(input: SessionInput, options: StreamOptions = {}) {
      inputs.push(input);
      calls.push(options);
      return emptyStream();
    },
  } as unknown as SessionHarness;
  return { agent, calls, inputs };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // discard — we assert on what the agent was called with, not the chunks
  }
}

describe("turnHasInput", () => {
  it("requires user text, an attachment, or tool results", () => {
    expect(turnHasInput({ content: "" })).toBe(false);
    expect(turnHasInput({ content: "   " })).toBe(false);
    expect(turnHasInput({ content: "hi" })).toBe(true);
    expect(
      turnHasInput({
        attachments: [{ url: "data:image/png;base64,AA" }],
        content: "",
      })
    ).toBe(true);
    expect(
      turnHasInput({
        content: "",
        toolResults: [{ output: "ok", toolCallId: "c1" }],
      })
    ).toBe(true);
  });
});

describe("toSessionInput", () => {
  it("projects bare text to a string input", () => {
    expect(toSessionInput({ content: "hello" })).toBe("hello");
  });

  it("projects text + attachments to multimodal parts", () => {
    const input = toSessionInput({
      attachments: [
        { mediaType: "image/png", url: "data:image/png;base64,AA" },
      ],
      content: "what is this?",
    });
    expect(input).toEqual({
      parts: [
        { text: "what is this?", type: "text" },
        {
          mediaType: "image/png",
          type: "image",
          url: "data:image/png;base64,AA",
        },
      ],
    });
  });

  it("projects tool results to tool_result parts on resume (text ignored)", () => {
    const input = toSessionInput({
      content: "ignored",
      toolResults: [{ isError: true, output: "file.txt", toolCallId: "c1" }],
    });
    expect(input).toEqual({
      parts: [
        {
          isError: true,
          output: "file.txt",
          toolCallId: "c1",
          type: "tool_result",
        },
      ],
    });
  });
});

describe("streamSessionAgent", () => {
  it("forwards the subscription abort signal into agent.stream", async () => {
    const { agent, calls } = recordingAgent();
    const controller = new AbortController();

    await drain(
      streamSessionAgent(
        agent,
        { content: "hi" },
        { signal: controller.signal }
      )
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("omits signal when none is supplied", async () => {
    const { agent, calls } = recordingAgent();
    await drain(streamSessionAgent(agent, { content: "hi" }));
    expect(calls[0]?.signal).toBeUndefined();
  });

  it("forwards the per-turn model and provider", async () => {
    const { agent, calls } = recordingAgent();
    await drain(
      streamSessionAgent(agent, {
        content: "hi",
        model: "claude-haiku-4-5",
        provider: "anthropic",
      })
    );
    expect(calls[0]).toMatchObject({
      model: "claude-haiku-4-5",
      provider: "anthropic",
    });
  });
});
