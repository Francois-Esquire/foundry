import { describe, expect, it } from "vitest";

import {
  sessionMessageSchema,
  sessionPartSchema,
  sessionRecordSchema,
  summarySchema,
} from "../schema";
import { InMemorySessionStore } from "../session/store";
import type { SessionPart } from "../session/types";

const everyPart: SessionPart[] = [
  {
    event: {
      agentId: "agent",
      harness: "claude",
      id: "activity-1",
      kind: "subagent",
      lifetime: "session",
      revision: 1,
      sessionId: "session-1",
      status: "running",
      title: "Explore",
    },
    type: "harness_activity",
  },
  {
    harness: "claude",
    outcome: "answered",
    questionCount: 2,
    toolCallId: "call-1",
    type: "harness_question",
  },
  {
    event: {
      agentId: "agent",
      harness: "claude",
      inputSummary: "ls",
      outcome: "ran",
      sessionId: "session-1",
      toolCallId: "call-2",
      toolName: "Bash",
    },
    type: "harness_tool",
  },
  { harness: "claude", nativeSessionId: "native-1", type: "harness_session" },
  { text: "hello", type: "text" },
  { text: "thinking", type: "reasoning" },
  { mediaType: "image/png", type: "image", url: "data:image/png;base64," },
  {
    input: { url: "https://example.com" },
    name: "web_fetch",
    provenance: {
      capability: { domain: "example.com", kind: "web.fetch" },
      effectLocation: "runtime",
      invocationId: "invocation-1",
      source: "builtin",
    },
    providerOptions: { google: { thoughtSignature: "sig" } },
    toolCallId: "call-3",
    type: "tool_call",
  },
  { output: "page", toolCallId: "call-3", type: "tool_result" },
  { message: "boom", type: "error" },
  {
    approvalId: "approval-1",
    approvalMode: "live",
    capability: { kind: "tool.call", source: "declared", tool: "deploy" },
    input: {},
    name: "deploy",
    toolCallId: "call-4",
    type: "tool_approval_request",
  },
  {
    approvalId: "approval-1",
    approved: true,
    scope: "once",
    type: "tool_approval_response",
  },
];

describe("session record schemas", () => {
  it("accept the records the in-memory store writes", async () => {
    const store = new InMemorySessionStore();
    const parent = await store.createSession({ title: "parent" });
    const child = await store.createSession({
      parentMessageId: "message-1",
      parentSessionId: parent.id,
      recursionDepth: 1,
    });
    const message = await store.appendMessage({
      metadata: {
        model: { id: "model", provider: "provider" },
        timing: { completedAt: 2, durationMs: 1, startedAt: 1 },
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
      parts: everyPart,
      role: "assistant",
      sessionId: child.id,
    });

    expect(sessionRecordSchema.parse(parent)).toEqual(parent);
    expect(sessionRecordSchema.parse(child)).toEqual(child);
    expect(sessionMessageSchema.parse(message)).toEqual(message);
  });

  it("refuses a part of a type the vocabulary does not define", () => {
    expect(
      sessionPartSchema.safeParse({ type: "video", url: "x" }).success
    ).toBe(false);
  });

  it("refuses records with an empty id or an unknown status", () => {
    const record = {
      createdAt: 1,
      id: "session-1",
      status: "active",
      title: null,
      updatedAt: 1,
    };

    expect(sessionRecordSchema.safeParse(record).success).toBe(true);
    expect(sessionRecordSchema.safeParse({ ...record, id: "" }).success).toBe(
      false
    );
    expect(
      sessionRecordSchema.safeParse({ ...record, status: "paused" }).success
    ).toBe(false);
  });

  it("accepts a cross-session digest", () => {
    const summary = { digestText: "digest", subjectSessionId: "session-1" };

    expect(summarySchema.parse(summary)).toEqual(summary);
  });
});
