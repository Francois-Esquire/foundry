import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { compileTool } from "../../harness/tool-compiler";
import type {
  HarnessToolRegistration,
  RegisteredToolCall,
  ToolEffectPort,
} from "../../harness/types";
import { fakeAuthorizer as fakePolicy } from "../helpers/authorizer";

function fakeEffectPort(): {
  port: ToolEffectPort;
  calls: RegisteredToolCall[];
} {
  const calls: RegisteredToolCall[] = [];
  return {
    calls,
    port: {
      execute(invocation, effect) {
        calls.push(invocation);
        return effect();
      },
    },
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

/**
 * Part B of task-08: `invocationId` must be a stable identity for one
 * logical tool call, not a fresh id minted on every `execute()` — an
 * externally visible tool keys idempotency on it (design: "Effect boundary";
 * gap-register G1), and a fresh id on replay could double-commit remotely.
 * Task 06's durable Step already works around the previous instability by
 * keying on `toolCallId` instead; this proves the compiler's own identity is
 * now trustworthy directly.
 */
describe("tool-compiler — invocationId stability (task-08 Part B)", () => {
  it("derives the same invocationId for a replayed continuation with the same toolCallId", async () => {
    const registration = registrationFor(({ x }) => x * 2);
    const { port, calls } = fakeEffectPort();
    const compiled = compileTool(registration, {
      agentId: "agent-1",
      effectPort: port,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
      sessionId: "sess-1",
    });

    // Two independent calls sharing the same `toolCallId` — a suspend/resume
    // or an approval continuation replaying the same logical call, not a
    // fresh model turn (which would mint a new `toolCallId`).
    await compiled.execute?.(
      { x: 1 },
      { context: undefined, messages: [], toolCallId: "call-1" }
    );
    await compiled.execute?.(
      { x: 1 },
      { context: undefined, messages: [], toolCallId: "call-1" }
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.invocationId).toBe(calls[1]?.invocationId);
  });

  it("scopes invocationId by agent and session so the same toolCallId never collides across them", async () => {
    const execute = vi.fn(({ x }: { x: number }) => x * 2);
    const registration = registrationFor(execute);
    const { port, calls } = fakeEffectPort();

    const compiledA = compileTool(registration, {
      agentId: "agent-a",
      effectPort: port,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
      sessionId: "sess-1",
    });
    const compiledB = compileTool(registration, {
      agentId: "agent-b",
      effectPort: port,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
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
    expect(calls[0]?.invocationId).not.toBe(calls[1]?.invocationId);
  });
});
