import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Capability } from "../../authorization";
import { SessionHarness } from "../../harness";
import type { SessionEvent } from "../../session";
import { InMemorySessionStore } from "../../session";
import {
  createScriptedMockModel,
  textStreamResult,
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

const capability: Capability = {
  kind: "mcp.tool",
  serverId: "s",
  tool: "dangerous",
};

/** Seed a session with an assistant turn that requested (and is awaiting) approval. */
async function seedPendingApproval(
  store: InMemorySessionStore,
  sessionId: string
) {
  await store.createSession({ id: sessionId });
  await store.appendMessage({
    parts: [{ text: "do it", type: "text" }],
    role: "user",
    sessionId,
  });
  await store.appendMessage({
    parts: [
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
    ],
    role: "assistant",
    sessionId,
  });
}

describe("SessionHarness — approval responses", () => {
  it("routes a tool_approval_response input to a tool-role message and actually executes the approved tool", async () => {
    const store = new InMemorySessionStore();
    await seedPendingApproval(store, "s1");

    const execute = vi.fn(async ({ target }: { target: string }) =>
      Promise.resolve(`did ${target}`)
    );
    const dangerous = tool({
      description: "does something dangerous",
      execute,
      inputSchema: z.object({ target: z.string() }),
      needsApproval: true,
    });
    const model = createScriptedMockModel({
      stream: [textStreamResult("done")],
    });

    const harness = new SessionHarness(
      {
        instructions: "x",
        model,
        sessionId: "s1",
        store,
        tools: { dangerous },
      },
      { sessionId: "s1" }
    );

    const events = await drain(
      harness.stream({
        parts: [
          {
            approvalId: "a1",
            approved: true,
            scope: "always",
            type: "tool_approval_response",
          },
        ],
      })
    );

    // The persisted, already-issued approval is honored — the tool actually
    // runs, proving the converter's reconstructed AI SDK parts round-trip
    // through the real tool loop, not just past a text-substring check.
    expect(execute).toHaveBeenCalledWith({ target: "prod" }, expect.anything());
    expect(events.some((e) => e.type === "tool-result")).toBe(true);

    const messages = await store.listMessages("s1");
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages[2]?.parts).toEqual([
      {
        approvalId: "a1",
        approved: true,
        scope: "always",
        type: "tool_approval_response",
      },
    ]);
  });

  it("rejects an approval response with no matching request, before touching the model or the store", async () => {
    const store = new InMemorySessionStore();
    await store.createSession({ id: "s2" });
    let modelCalled = false;
    const model = createScriptedMockModel({});
    const originalDoStream = model.doStream.bind(model);
    model.doStream = (options) => {
      modelCalled = true;
      return originalDoStream(options);
    };

    const harness = new SessionHarness(
      { instructions: "x", model, sessionId: "s2", store, tools: {} },
      { sessionId: "s2" }
    );

    const events = await drain(
      harness.stream({
        parts: [
          {
            approvalId: "missing",
            approved: true,
            type: "tool_approval_response",
          },
        ],
      })
    );

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(modelCalled).toBe(false);
    expect(await store.listMessages("s2")).toEqual([]);
  });

  it("rejects a duplicate response for an already-resolved approval", async () => {
    const store = new InMemorySessionStore();
    await seedPendingApproval(store, "s3");
    await store.appendMessage({
      parts: [
        { approvalId: "a1", approved: true, type: "tool_approval_response" },
      ],
      role: "tool",
      sessionId: "s3",
    });

    const model = createScriptedMockModel({});
    const harness = new SessionHarness(
      { instructions: "x", model, sessionId: "s3", store, tools: {} },
      { sessionId: "s3" }
    );

    const events = await drain(
      harness.stream({
        parts: [
          { approvalId: "a1", approved: false, type: "tool_approval_response" },
        ],
      })
    );

    expect(events.some((e) => e.type === "error")).toBe(true);
    // No second response got appended past the one already seeded.
    const messages = await store.listMessages("s3");
    expect(
      messages.filter((m) =>
        m.parts.some((p) => p.type === "tool_approval_response")
      )
    ).toHaveLength(1);
  });
});
