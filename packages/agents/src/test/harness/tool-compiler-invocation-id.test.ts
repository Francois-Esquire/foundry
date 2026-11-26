import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentAuthorizationRequest } from "../../authorization/authorization";
import { compileTool } from "../../harness/tool-compiler";
import type { HarnessToolRegistration } from "../../harness/tool-registration";
import { fakeAuthorizer as fakePolicy } from "../helpers/authorizer";

function recordingPolicy() {
  const calls: AgentAuthorizationRequest[] = [];
  return {
    calls,
    policy: fakePolicy((request) => {
      calls.push(request);
      return { kind: "allow", source: "grant" };
    }),
  };
}

function registrationFor(
  execute: (input: { x: number }) => unknown
): HarnessToolRegistration {
  return {
    capability: () => ({
      kind: "tool.call",
      source: "declared",
      tool: "double",
    }),
    name: "double",
    source: "declared",
    tool: tool({
      description: "doubles a number",
      execute,
      inputSchema: z.object({ x: z.number() }),
    }),
  };
}

describe("tool compiler invocation ID stability", () => {
  it("derives the same invocationId for a replayed continuation with the same toolCallId", async () => {
    const registration = registrationFor(({ x }) => x * 2);
    const { policy, calls } = recordingPolicy();
    const compiled = compileTool(registration, {
      agentId: "agent-1",
      policy,
      sessionId: "sess-1",
    });

    await compiled.execute?.(
      { x: 1 },
      { context: undefined, messages: [], toolCallId: "call-1" }
    );
    await compiled.execute?.(
      { x: 1 },
      { context: undefined, messages: [], toolCallId: "call-1" }
    );

    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.invocationId)).size).toBe(1);
  });

  it("scopes invocationId by agent and session so the same toolCallId never collides across them", async () => {
    const execute = vi.fn(({ x }: { x: number }) => x * 2);
    const registration = registrationFor(execute);
    const { policy, calls } = recordingPolicy();

    const compiledA = compileTool(registration, {
      agentId: "agent-a",
      policy,
      sessionId: "sess-1",
    });
    const compiledB = compileTool(registration, {
      agentId: "agent-b",
      policy,
      sessionId: "sess-1",
    });

    await compiledA.execute?.(
      { x: 1 },
      { context: undefined, messages: [], toolCallId: "call-1" }
    );
    await compiledB.execute?.(
      { x: 1 },
      { context: undefined, messages: [], toolCallId: "call-1" }
    );

    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.invocationId)).size).toBe(2);
  });
});
