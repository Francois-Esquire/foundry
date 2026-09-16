import { describe, expect, it, vi } from "vitest";

import type { StreamPart } from "../../harness";
import { transformStream } from "../../harness";
import type { SessionEvent } from "../../session/events";

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

const flatUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

const textParts: StreamPart[] = [
  { delta: "hello there", type: "text-delta" },
  { type: "text-end" },
  { type: "finish", usage: flatUsage },
];

describe("transformStream", () => {
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
      {
        type: "finish",
        usage: {
          inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 20 },
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
        },
      },
    ];

    const stream = transformStream(source(parts));
    await collect(stream);

    expect(await stream.usage).toMatchObject({
      cachedInputTokens: 80,
      cacheWriteTokens: 20,
    });
  });

  it("captures cacheWriteTokens from a flat usage field", async () => {
    const parts: StreamPart[] = [
      {
        type: "finish",
        usage: { ...flatUsage, cacheWriteTokens: 7 },
      },
    ];

    const stream = transformStream(source(parts));
    await collect(stream);

    expect((await stream.usage).cacheWriteTokens).toBe(7);
  });

  it("maps tool calls and results to events and fires handlers", async () => {
    const parts: StreamPart[] = [
      {
        input: { q: "hello" },
        toolCallId: "call-1",
        toolName: "search",
        type: "tool-call",
      },
      {
        output: { hits: 2 },
        toolCallId: "call-1",
        type: "tool-result",
      },
      { type: "finish", usage: flatUsage },
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
      {
        input: { agent: "planning", message: "hi" },
        toolCallId: "call-1",
        toolName: "message_agent",
        type: "tool-call",
      },
      {
        output: { partial: true },
        preliminary: true,
        toolCallId: "call-1",
        type: "tool-result",
      },
      {
        output: { partial: false },
        toolCallId: "call-1",
        type: "tool-result",
      },
      { type: "finish", usage: flatUsage },
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
        input: { cmd: "ls" },
        providerMetadata: { google: { thoughtSignature: "sig-abc" } },
        toolCallId: "call-1",
        toolName: "bash",
        type: "tool-call",
      },
      { type: "finish", usage: flatUsage },
    ];

    const stream = transformStream(source(parts));
    await collect(stream);

    const toolCall = (await stream.message).parts.find(
      (p) => p.type === "tool_call"
    );
    expect(toolCall).toMatchObject({
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
        {
          input: { q: "hello" },
          provenance,
          toolCallId: "call-1",
          toolName: "search",
          type: "tool-call",
        },
        { type: "finish", usage: flatUsage },
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
      { delta: "thinking", type: "reasoning-delta" },
      { type: "reasoning-end" },
      { delta: "final", type: "text-delta" },
      { type: "text-end" },
      { type: "finish", usage: flatUsage },
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
      { delta: "partial", type: "text-delta" },
      { error: new Error("chunk boom"), type: "error" },
      { type: "finish", usage: flatUsage },
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
      yield { delta: "partial", type: "text-delta" };
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
      (msg: Awaited<ReturnType<typeof transformStream>["message"]>) =>
        Promise.resolve({
          ...msg,
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
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({
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
      yield { delta: "partial", type: "text-delta" };
      throw new Error("stream boom");
    }

    const commit = vi.fn((msg) =>
      Promise.resolve({ ...msg, sessionId: "session-1" })
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
        toolCall: { input: { x: 1 }, toolCallId: "call-1", toolName: "danger" },
        type: "tool-approval-request",
      },
      { type: "finish", usage: flatUsage },
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
});
