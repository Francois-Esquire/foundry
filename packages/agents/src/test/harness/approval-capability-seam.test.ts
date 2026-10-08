import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createInMemoryAgentAuthorizer } from "../../authorization/authorization";
import { SessionHarness } from "../../harness/session-harness";
import { tagTool } from "../../harness/types";
import type { SessionEvent } from "../../session/events";
import { InMemorySessionStore } from "../../session/store";
import {
  createScriptedMockModel,
  toolCallStreamResult,
} from "../helpers/mock-language-model";

async function drain(
  stream: AsyncIterable<SessionEvent>
): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of stream) {
    out.push(event);
  }
  return out;
}

/**
 * Exercises the full `AgentHarness` → `SessionHarness` → `transformStream`
 * path, verifying the compiler's registration-derived capability reaches both
 * the live approval event and the persisted session message.
 */
describe("stream-transform capability propagation", () => {
  it("attaches the registration-derived capability to the live tool-approval-request event", async () => {
    const dangerous = tool({
      description: "does something dangerous",
      execute: ({ target }: { target: string }) => `did ${target}`,
      inputSchema: z.object({ target: z.string() }),
    });
    const tools = {
      dangerous: tagTool(dangerous, {
        capability: () => ({
          kind: "mcp.tool",
          serverId: "s",
          tool: "dangerous",
        }),
        source: "mcp",
      }),
    };
    // A blanket "ask" default makes this capability approval-required —
    // no exact grant, no kind override.
    const policy = createInMemoryAgentAuthorizer({
      policy: { global: "ask" },
    }).authorizer;

    const model = createScriptedMockModel({
      stream: [toolCallStreamResult("call-1", "dangerous", { target: "prod" })],
    });

    const harness = new SessionHarness(
      {
        instructions: "x",
        model,
        policy,
        sessionId: "s1",
        store: new InMemorySessionStore(),
        tools,
      },
      { sessionId: "s1" }
    );

    const events = await drain(harness.stream("do it"));
    const request = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-approval-request" }> =>
        e.type === "tool-approval-request"
    );

    expect(request).toBeDefined();
    expect(request?.capability).toEqual({
      kind: "mcp.tool",
      serverId: "s",
      tool: "dangerous",
    });

    const messages = await harness.store.listMessages("s1");
    const persistedRequest = messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === "tool_approval_request");
    expect(persistedRequest).toMatchObject({
      capability: { kind: "mcp.tool", serverId: "s", tool: "dangerous" },
    });
  });
});
