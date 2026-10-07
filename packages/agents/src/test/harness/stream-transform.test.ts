import { describe, expect, it, vi } from "vitest";

import type { StreamPart } from "../../harness/stream-transform";
import { transformStream } from "../../harness/stream-transform";
import type { SessionEvent } from "../../session/events";
import {
  finish,
  reasoningDelta,
  textDelta,
  toolCall,
  toolResult,
  usage,
} from "../helpers/stream-parts";

async function collect(stream: AsyncIterable<SessionEvent>) {
  const events: SessionEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function* source(parts: StreamPart[]): AsyncGenerator<StreamPart> {
  for (const part of parts) {
    yield part;
  }
  await Promise.resolve();
}

const flatUsage = usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });

const textParts: StreamPart[] = [
  textDelta("hello there"),
  { id: "text-1", type: "text-end" },
  finish(flatUsage),
];

describe("transformStream", () => {
  it("records SDK abort chunks as interruption rather than successful completion", async () => {
    const stream = transformStream(
      source([
        textDelta("partial"),
        { reason: "Question interrupted.", type: "abort" },
      ])
    );
    const events = await collect(stream);
    expect((await stream.message).status).toBe("error");
    expect((await stream.message).parts).toContainEqual({
      message: "Question interrupted.",
      type: "error",
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "finish" })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: "Question interrupted." }),
        type: "error",
      })
    );
  });

  it("transforms a text stream into SessionEvents and resolves finals", async () => {
    const stream = transformStream(source(textParts));

    const events = await collect(stream);

    expect(events).toContainEqual({
      delta: "hello there",
      type: "text-delta",
    });
    expect(events.at(-1)?.type).toBe("finish");
    expect(await stream.text).toBe("hello there");
    expect((await stream.message).role).toBe("assistant");
    expect((await stream.message).status).toBe("complete");
  });

  it("fires handlers as events arrive", async () => {
    const onText = vi.fn();
    const onFinish = vi.fn();

    await collect(
      transformStream(source(textParts), {
        handlers: { onFinish, onText },
      })
    );

    expect(onText).toHaveBeenCalledWith("hello there");
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0]?.[0]).toMatchObject({
      message: { role: "assistant" },
    });
  });

  it("enriches the message with model metadata", async () => {
    const stream = transformStream(source(textParts), {
      model: { harness: "studio", id: "opus-x", provider: "gateway" },
    });

    await collect(stream);

    const meta = (await stream.message).metadata;
    expect(meta?.model).toEqual({
      harness: "studio",
      id: "opus-x",
      provider: "gateway",
    });
    expect(meta?.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    expect(typeof meta?.timing?.durationMs).toBe("number");
  });

  it("captures usage from the finish chunk", async () => {
    const stream = transformStream(source(textParts));

    await collect(stream);

    expect(await stream.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("captures cache read/write from the SDK's nested inputTokenDetails", async () => {
    const parts: StreamPart[] = [
      finish(
        usage({
          cacheReadTokens: 80,
          cacheWriteTokens: 20,
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
        })
      ),
    ];

    const stream = transformStream(source(parts));
    await collect(stream);

    expect(await stream.usage).toMatchObject({
      cachedInputTokens: 80,
      cacheWriteTokens: 20,
    });
  });

  it("captures reasoning tokens from the SDK's nested outputTokenDetails", async () => {
    const stream = transformStream(
      source([finish(usage({ outputTokens: 9, reasoningTokens: 4 }))])
    );
    await collect(stream);

    expect(await stream.usage).toEqual({
      inputTokens: 0,
      outputTokens: 9,
      reasoningTokens: 4,
      totalTokens: 9,
    });
  });

  it("maps tool calls and results to events and fires handlers", async () => {
    const parts: StreamPart[] = [
      toolCall("call-1", "search", { q: "hello" }),
      toolResult("call-1", { hits: 2 }),
      finish(flatUsage),
    ];
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();

    const events = await collect(
      transformStream(source(parts), {
        handlers: { onToolCall, onToolResult },
      })
    );

    expect(events).toContainEqual({
      input: { q: "hello" },
      name: "search",
      toolCallId: "call-1",
      type: "tool-call",
    });
    expect(events).toContainEqual({
      output: { hits: 2 },
      toolCallId: "call-1",
      type: "tool-result",
    });
    expect(onToolCall).toHaveBeenCalledWith({
      input: { q: "hello" },
      name: "search",
      toolCallId: "call-1",
    });
    expect(onToolResult).toHaveBeenCalledWith({
      output: { hits: 2 },
      toolCallId: "call-1",
    });
    const msgParts = (await collect(transformStream(source(parts)))).length;
    expect(msgParts).toBeGreaterThan(0);
  });

  it("forwards a preliminary tool result as an event but keeps it out of history", async () => {
    const parts: StreamPart[] = [
      toolCall("call-1", "message_agent", { agent: "planning", message: "hi" }),
      toolResult("call-1", { partial: true }, true),
      toolResult("call-1", { partial: false }),
      finish(flatUsage),
    ];
    const onToolResult = vi.fn();
    const stream = transformStream(source(parts), {
      handlers: { onToolResult },
    });
    const events = await collect(stream);

    expect(events).toContainEqual({
      output: { partial: true },
      preliminary: true,
      toolCallId: "call-1",
      type: "tool-result",
    });
    expect(onToolResult).toHaveBeenCalledWith({
      output: { partial: true },
      preliminary: true,
      toolCallId: "call-1",
    });
    const message = await stream.message;
    const results = message.parts.filter((p) => p.type === "tool_result");
    expect(results).toEqual([
      { output: { partial: false }, toolCallId: "call-1", type: "tool_result" },
    ]);
  });

  it("captures a tool-call's providerMetadata onto the tool_call part (Gemini thoughtSignature)", async () => {
    const parts: StreamPart[] = [
      {
        ...toolCall("call-1", "bash", { cmd: "ls" }),
        providerMetadata: { google: { thoughtSignature: "sig-abc" } },
      },
      finish(flatUsage),
    ];

    const stream = transformStream(source(parts));
    await collect(stream);

    const persisted = (await stream.message).parts.find(
      (p) => p.type === "tool_call"
    );
    expect(persisted).toMatchObject({
      providerOptions: { google: { thoughtSignature: "sig-abc" } },
      type: "tool_call",
    });
  });

  it("captures registration provenance on the tool_call part and event", async () => {
    const provenance = {
      agentId: "workspace",
      capability: {
        kind: "mcp.tool" as const,
        serverId: "github",
        tool: "search",
      },
      effectLocation: "host" as const,
      invocationId: "workspace:session:call-1",
      source: "mcp" as const,
    };
    const stream = transformStream(
      source([
        { ...toolCall("call-1", "search", { q: "hello" }), provenance },
        finish(flatUsage),
      ])
    );

    const events = await collect(stream);

    expect(events).toContainEqual({
      input: { q: "hello" },
      name: "search",
      provenance,
      toolCallId: "call-1",
      type: "tool-call",
    });
    expect((await stream.message).parts[0]).toEqual({
      input: { q: "hello" },
      name: "search",
      provenance,
      toolCallId: "call-1",
      type: "tool_call",
    });
  });

  it("maps reasoning deltas to events", async () => {
    const parts: StreamPart[] = [
      reasoningDelta("thinking"),
      { id: "reasoning-1", type: "reasoning-end" },
      textDelta("final"),
      { id: "text-1", type: "text-end" },
      finish(flatUsage),
    ];

    const stream = transformStream(source(parts));
    const events = await collect(stream);

    expect(events).toContainEqual({
      delta: "thinking",
      type: "reasoning-delta",
    });
    const msg = await stream.message;
    expect(msg.parts).toEqual([
      { text: "thinking", type: "reasoning" },
      { text: "final", type: "text" },
    ]);
    expect(await stream.text).toBe("final");
  });

  it("forwards error events from a non-throwing error chunk and still finishes", async () => {
    const parts: StreamPart[] = [
      textDelta("partial"),
      { error: new Error("chunk boom"), type: "error" },
      finish(flatUsage),
    ];
    const onError = vi.fn();

    const stream = transformStream(source(parts), {
      handlers: { onError },
    });
    const events = await collect(stream);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.at(-1)?.type).toBe("finish");
    expect((await stream.message).status).toBe("complete");
  });

  it("emits an error event and no finish when the stream throws", async () => {
    async function* throwingSource(): AsyncGenerator<StreamPart> {
      await Promise.resolve();
      yield textDelta("partial");
      throw new Error("stream boom");
    }

    const onError = vi.fn();
    const stream = transformStream(throwingSource(), {
      handlers: { onError },
    });
    const events = await collect(stream);

    expect(onError).toHaveBeenCalledWith(new Error("stream boom"));
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
    expect((await stream.message).status).toBe("error");
    expect(await stream.text).toBe("partial");
  });

  it("calls commit and uses its result as the final message", async () => {
    const commit = vi.fn(
      (message: Awaited<ReturnType<typeof transformStream>["message"]>) =>
        Promise.resolve({
          ...message,
          id: "persisted-id",
          sessionId: "session-1",
        })
    );

    const stream = transformStream(source(textParts), {
      commit,
      model: { id: "opus-x" },
    });
    const events = await collect(stream);

    expect(commit).toHaveBeenCalledTimes(1);
    const msg = await stream.message;
    expect(msg.id).toBe("persisted-id");
    expect(msg.sessionId).toBe("session-1");
    const finished = events.find((e) => e.type === "finish");
    expect(finished).toMatchObject({
      message: { id: "persisted-id", sessionId: "session-1" },
      type: "finish",
    });
  });

  it("falls back to the enriched message when commit throws", async () => {
    const stream = transformStream(source(textParts), {
      commit: () => Promise.reject(new Error("db down")),
      model: { id: "opus-x" },
    });

    const events = await collect(stream);
    const msg = await stream.message;

    expect(msg.status).toBe("complete");
    expect(msg.metadata?.model?.id).toBe("opus-x");
    expect(events.at(-1)?.type).toBe("finish");
  });

  it("calls commit even for error messages", async () => {
    async function* throwingSource(): AsyncGenerator<StreamPart> {
      await Promise.resolve();
      yield textDelta("partial");
      throw new Error("stream boom");
    }

    const commit = vi.fn((message) =>
      Promise.resolve({ ...message, sessionId: "session-1" })
    );

    const stream = transformStream(throwingSource(), { commit });
    await collect(stream);

    expect(commit).toHaveBeenCalledTimes(1);
    const msg = await stream.message;
    expect(msg.status).toBe("error");
    expect(msg.sessionId).toBe("session-1");
  });

  it("settles finals even without iterating", async () => {
    const onFinish = vi.fn();
    const stream = transformStream(source(textParts), {
      handlers: { onFinish },
    });

    expect(await stream.text).toBe("hello there");
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect((await stream.message).status).toBe("complete");
  });

  it("preserves a tool-approval-request as a session part, fires the handler, and reports awaiting-approval", async () => {
    const capability = {
      kind: "mcp.tool",
      serverId: "s",
      tool: "danger",
    } as const;
    const parts: StreamPart[] = [
      {
        approvalId: "appr-1",
        capability,
        signature: "sig",
        toolCall: toolCall("call-1", "danger", { x: 1 }),
        type: "tool-approval-request",
      },
      finish(flatUsage),
    ];
    const onApprovalRequest = vi.fn();

    const stream = transformStream(source(parts), {
      handlers: { onApprovalRequest },
    });
    const events = await collect(stream);

    expect(events).toContainEqual({
      approvalId: "appr-1",
      capability,
      input: { x: 1 },
      signature: "sig",
      toolCallId: "call-1",
      toolName: "danger",
      type: "tool-approval-request",
    });
    expect(onApprovalRequest).toHaveBeenCalledWith({
      approvalId: "appr-1",
      capability,
      input: { x: 1 },
      signature: "sig",
      toolCallId: "call-1",
      toolName: "danger",
    });

    const message = await stream.message;
    expect(message.parts).toContainEqual({
      approvalId: "appr-1",
      capability,
      input: { x: 1 },
      name: "danger",
      signature: "sig",
      toolCallId: "call-1",
      type: "tool_approval_request",
    });
    expect(await stream.outcome).toBe("awaiting-approval");
  });

  it("reports a complete outcome when no approval is requested", async () => {
    const stream = transformStream(source(textParts));
    await collect(stream);
    expect(await stream.outcome).toBe("complete");
  });
  it("closes the open text part at a tool error, so later text starts a new part", async () => {
    const stream = transformStream(
      source([
        textDelta("before"),
        toolCall("call-1", "search", { q: "x" }),
        {
          error: new Error("search failed"),
          input: { q: "x" },
          toolCallId: "call-1",
          toolName: "search",
          type: "tool-error",
        },
        textDelta("after"),
        finish(flatUsage),
      ])
    );
    await collect(stream);

    expect((await stream.message).parts).toEqual([
      { text: "before", type: "text" },
      {
        input: { q: "x" },
        name: "search",
        toolCallId: "call-1",
        type: "tool_call",
      },
      {
        isError: true,
        output: "search failed",
        toolCallId: "call-1",
        type: "tool_result",
      },
      { text: "after", type: "text" },
    ]);
  });

  it("keeps text open when a reasoning block ends inside it", async () => {
    const stream = transformStream(
      source([
        reasoningDelta("thinking"),
        textDelta("a"),
        { id: "reasoning-1", type: "reasoning-end" },
        textDelta("b"),
        finish(flatUsage),
      ])
    );
    await collect(stream);

    expect((await stream.message).parts).toEqual([
      { text: "thinking", type: "reasoning" },
      { text: "ab", type: "text" },
    ]);
  });

  it("keeps one text part across a driver's out-of-band activity update", async () => {
    const event = {
      agentId: "agent-1",
      harness: "codex",
      id: "activity-1",
      kind: "subagent" as const,
      lifetime: "session" as const,
      revision: 1,
      sessionId: "s1",
      status: "running" as const,
      title: "Child",
    };
    const stream = transformStream(
      source([
        textDelta("one "),
        { event, type: "harness-activity" },
        textDelta("two"),
        finish(flatUsage),
      ])
    );
    const events = await collect(stream);

    expect(events).toContainEqual({ event, type: "harness-activity" });
    expect((await stream.message).parts).toEqual([
      { text: "one two", type: "text" },
    ]);
  });

  it("maps a driver approval request to an event without persisting a part", async () => {
    const approval = {
      agentId: "agent-1",
      approvalId: "appr-1",
      capability: { kind: "tool.call", source: "declared", tool: "Bash" },
      input: "Input fields: command",
      toolCallId: "call-1",
      toolName: "Bash",
    } as const;
    const onApprovalRequest = vi.fn();
    const stream = transformStream(
      source([{ ...approval, type: "harness-approval-request" }]),
      { handlers: { onApprovalRequest } }
    );
    const events = await collect(stream);

    expect(events).toContainEqual({
      ...approval,
      type: "tool-approval-request",
    });
    expect(onApprovalRequest).toHaveBeenCalledWith(approval);
    expect((await stream.message).parts).toEqual([]);
    expect(await stream.outcome).toBe("complete");
  });

  it("fails the turn on an approval request with no registered capability", async () => {
    const stream = transformStream(
      source([
        {
          approvalId: "appr-1",
          toolCall: toolCall("call-1", "unknown", {}),
          type: "tool-approval-request",
        },
      ])
    );
    await collect(stream);

    const message = await stream.message;
    expect(message.status).toBe("error");
    expect(message.parts).toEqual([
      {
        message:
          'Approval request for "unknown" carries no registered capability.',
        type: "error",
      },
    ]);
  });
});
