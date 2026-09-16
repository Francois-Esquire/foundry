import type { ModelMessage } from "ai";

import { describe, expect, it } from "vitest";

import type { Capability } from "../../authorization";
import type { SessionMessage, SessionPart, SessionRole } from "../../session";

import {
  InvalidApprovalResponseError,
  toModelMessages,
  validateApprovalResponse,
} from "../../session/converter";

const capability: Capability = {
  kind: "mcp.tool",
  serverId: "s",
  tool: "dangerous",
};

// SessionMessage → UIMessage → ModelMessage via the AI SDK's
// convertToModelMessages. Tests cover the three transcript shapes (server
// in-turn, client pause/resume, abandoned) and edge cases.

let seq = 0;
function msg(role: SessionRole, parts: SessionPart[]): SessionMessage {
  seq += 1;
  return {
    createdAt: 0,
    id: `m${seq}`,
    parts,
    role,
    sessionId: "s",
    status: "complete",
    updatedAt: 0,
  };
}

/** Narrow helper: a message's content as an array of part objects. */
function partsOf(message: ModelMessage | undefined): Record<string, unknown>[] {
  const content = message?.content;
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}

describe("toModelMessages", () => {
  it("projects a pure-text turn as content arrays", async () => {
    const out = await toModelMessages([
      msg("user", [{ text: "hi", type: "text" }]),
      msg("assistant", [{ text: "hello", type: "text" }]),
    ]);
    expect(out).toEqual([
      { content: [{ text: "hi", type: "text" }], role: "user" },
      { content: [{ text: "hello", type: "text" }], role: "assistant" },
    ]);
  });

  it("splits an in-turn server-tool message into assistant(call+text) → tool(result)", async () => {
    const out = await toModelMessages([
      msg("user", [{ text: "find it", type: "text" }]),
      msg("assistant", [
        {
          input: { q: "x" },
          name: "search",
          toolCallId: "c1",
          type: "tool_call",
        },
        { output: { hits: 2 }, toolCallId: "c1", type: "tool_result" },
        { text: "found 2", type: "text" },
      ]),
    ]);

    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    // assistant carries the tool-call and trailing text together
    expect(partsOf(out[1]).some((p) => p.type === "tool-call")).toBe(true);
    expect(partsOf(out[1]).some((p) => p.type === "text")).toBe(true);
    // tool message carries the matching result
    expect(partsOf(out[2])[0]).toMatchObject({
      toolCallId: "c1",
      toolName: "search",
      type: "tool-result",
    });
  });

  it("replays a tool_call's providerOptions onto the assistant tool-call (Gemini thoughtSignature)", async () => {
    const out = await toModelMessages([
      msg("user", [{ text: "run it", type: "text" }]),
      msg("assistant", [
        {
          input: { cmd: "ls" },
          name: "bash",
          providerOptions: { google: { thoughtSignature: "sig-abc" } },
          toolCallId: "c1",
          type: "tool_call",
        },
        { output: "ok", toolCallId: "c1", type: "tool_result" },
      ]),
    ]);

    // The assistant tool-call must carry providerOptions so a re-sent request
    // doesn't 400 on Gemini 3. Exercises the real convertToModelMessages
    // (callProviderMetadata → providerOptions) hop end to end.
    const toolCall = partsOf(out[1]).find((p) => p.type === "tool-call");
    expect(toolCall?.providerOptions).toEqual({
      google: { thoughtSignature: "sig-abc" },
    });
  });

  it("pairs a paused tool-call (lone) with a later tool-role result message", async () => {
    const out = await toModelMessages([
      msg("user", [{ text: "run ls", type: "text" }]),
      msg("assistant", [
        {
          input: { command: "ls" },
          name: "bash",
          toolCallId: "c1",
          type: "tool_call",
        },
      ]),
      msg("tool", [
        { output: "file.txt", toolCallId: "c1", type: "tool_result" },
      ]),
      msg("assistant", [{ text: "done", type: "text" }]),
    ]);

    expect(out.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(partsOf(out[1])[0]).toMatchObject({
      toolCallId: "c1",
      toolName: "bash",
      type: "tool-call",
    });
    expect(partsOf(out[2])[0]).toMatchObject({
      output: { type: "text", value: "file.txt" },
      toolCallId: "c1",
      toolName: "bash",
      type: "tool-result",
    });
  });

  it("passes an abandoned tool-call through without synthesizing a result", async () => {
    const out = await toModelMessages([
      msg("user", [{ text: "go", type: "text" }]),
      msg("assistant", [
        {
          input: { command: "sleep 99" },
          name: "bash",
          toolCallId: "c1",
          type: "tool_call",
        },
      ]),
      msg("user", [{ text: "never mind", type: "text" }]),
    ]);

    // SDK does not synthesize a cancellation result — the call just passes
    // through as an assistant message with an unanswered tool-call.
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(partsOf(out[1]).some((p) => p.type === "tool-call")).toBe(true);
  });

  it("groups parallel calls and their results", async () => {
    const out = await toModelMessages([
      msg("assistant", [
        { input: {}, name: "read", toolCallId: "a", type: "tool_call" },
        { input: {}, name: "read", toolCallId: "b", type: "tool_call" },
        { output: "A", toolCallId: "a", type: "tool_result" },
        { output: "B", toolCallId: "b", type: "tool_result" },
        { text: "ok", type: "text" },
      ]),
    ]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool"]);
    const calls = partsOf(out[0]).filter((p) => p.type === "tool-call");
    expect(calls).toHaveLength(2);
    expect(partsOf(out[1])).toHaveLength(2);
  });

  it("marks an errored tool result as error-text", async () => {
    const out = await toModelMessages([
      msg("assistant", [
        { input: {}, name: "bash", toolCallId: "c1", type: "tool_call" },
        {
          isError: true,
          output: "boom",
          toolCallId: "c1",
          type: "tool_result",
        },
      ]),
    ]);
    expect(partsOf(out[1])[0]).toMatchObject({
      output: { type: "error-text", value: "boom" },
    });
  });

  it("carries user images and preserves reasoning in the projection", async () => {
    const out = await toModelMessages([
      msg("user", [
        { text: "what is this?", type: "text" },
        {
          mediaType: "image/png",
          type: "image",
          url: "data:image/png;base64,AAA",
        },
      ]),
      msg("assistant", [
        { text: "hmm", type: "reasoning" },
        { text: "a cat", type: "text" },
      ]),
    ]);
    // image maps to a file part in the user message
    expect(partsOf(out[0]).some((p) => p.type === "file")).toBe(true);
    // reasoning is preserved alongside text in the assistant message
    expect(partsOf(out[1]).some((p) => p.type === "reasoning")).toBe(true);
    expect(partsOf(out[1]).some((p) => p.type === "text")).toBe(true);
  });

  it("recreates an unresolved approval request as a real tool-approval-request part", async () => {
    const out = await toModelMessages([
      msg("user", [{ text: "do it", type: "text" }]),
      msg("assistant", [
        {
          input: { target: "prod" },
          name: "dangerous",
          toolCallId: "c1",
          type: "tool_call",
        },
        {
          approvalId: "a1",
          capability,
          input: { target: "prod" },
          name: "dangerous",
          signature: "sig",
          toolCallId: "c1",
          type: "tool_approval_request",
        },
      ]),
    ]);

    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(partsOf(out[1])).toContainEqual({
      approvalId: "a1",
      signature: "sig",
      toolCallId: "c1",
      type: "tool-approval-request",
    });
  });

  it("recreates an approved (not-yet-executed) response as a real tool-approval-response part", async () => {
    const out = await toModelMessages([
      msg("assistant", [
        {
          input: { target: "prod" },
          name: "dangerous",
          toolCallId: "c1",
          type: "tool_call",
        },
        {
          approvalId: "a1",
          capability,
          input: { target: "prod" },
          name: "dangerous",
          toolCallId: "c1",
          type: "tool_approval_request",
        },
      ]),
      msg("tool", [
        { approvalId: "a1", approved: true, type: "tool_approval_response" },
      ]),
    ]);

    expect(out.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(partsOf(out[0])).toContainEqual({
      approvalId: "a1",
      toolCallId: "c1",
      type: "tool-approval-request",
    });
    expect(partsOf(out[1])).toContainEqual({
      approvalId: "a1",
      approved: true,
      providerExecuted: undefined,
      reason: undefined,
      type: "tool-approval-response",
    });
  });

  it("synthesizes a denied tool-result from a denied approval response, with no separate tool_result", async () => {
    const out = await toModelMessages([
      msg("assistant", [
        {
          input: { target: "prod" },
          name: "dangerous",
          toolCallId: "c1",
          type: "tool_call",
        },
        {
          approvalId: "a1",
          capability,
          input: { target: "prod" },
          name: "dangerous",
          toolCallId: "c1",
          type: "tool_approval_request",
        },
      ]),
      msg("tool", [
        {
          approvalId: "a1",
          approved: false,
          reason: "not now",
          type: "tool_approval_response",
        },
      ]),
    ]);

    expect(out.map((m) => m.role)).toEqual(["assistant", "tool"]);
    const toolResult = partsOf(out[1]).find((p) => p.type === "tool-result");
    expect(toolResult).toMatchObject({
      output: { type: "error-text", value: "not now" },
      toolCallId: "c1",
    });
  });
});

describe("validateApprovalResponse", () => {
  const request: SessionPart = {
    approvalId: "a1",
    capability,
    input: {},
    name: "dangerous",
    toolCallId: "c1",
    type: "tool_approval_request",
  };
  const historyWithRequest: SessionMessage[] = [msg("assistant", [request])];

  it("accepts a response that resolves a pending, unresolved request", () => {
    expect(() => {
      validateApprovalResponse(historyWithRequest, {
        approvalId: "a1",
        approved: true,
        type: "tool_approval_response",
      });
    }).not.toThrow();
  });

  it("rejects a response with no matching request", () => {
    expect(() => {
      validateApprovalResponse([], {
        approvalId: "missing",
        approved: true,
        type: "tool_approval_response",
      });
    }).toThrow(InvalidApprovalResponseError);
  });

  it("rejects a duplicate response for an already-resolved approval", () => {
    const history: SessionMessage[] = [
      msg("assistant", [request]),
      msg("tool", [
        { approvalId: "a1", approved: true, type: "tool_approval_response" },
      ]),
    ];
    expect(() => {
      validateApprovalResponse(history, {
        approvalId: "a1",
        approved: false,
        type: "tool_approval_response",
      });
    }).toThrow(InvalidApprovalResponseError);
  });

  it("rejects a response for a tool call that already executed", () => {
    const history: SessionMessage[] = [
      msg("assistant", [request]),
      msg("tool", [{ output: "done", toolCallId: "c1", type: "tool_result" }]),
    ];
    expect(() => {
      validateApprovalResponse(history, {
        approvalId: "a1",
        approved: true,
        type: "tool_approval_response",
      });
    }).toThrow(InvalidApprovalResponseError);
  });
});
