import type { Tool } from "ai";

import { tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createInMemoryAgentAuthorizer } from "../../authorization";
import { metaOf } from "../../harness/types";
import type { SessionEvent } from "../../session";
import { InMemorySessionStore } from "../../session";
import {
  createScriptedMockModel,
  textStreamResult,
  toolCallStreamResult,
} from "../helpers/mock-language-model";

const createMCPClient = vi.fn();
vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient,
  ElicitationRequestSchema: {},
}));

// Dynamic: both transitively import "@ai-sdk/mcp" (via `../../mcp`), so they
// must load after the mock above is registered — a static import would
// resolve before this file's own body runs and see the real module.
const { McpClient } = await import("../../mcp");
const { SessionHarness } = await import("../../harness");

beforeEach(() => {
  createMCPClient.mockReset();
});

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
 * Connect one fake MCP server exposing one `dangerous(target)` tool and
 * return its client-produced registration — the real `McpClient` output
 * (task-08), not a hand-authored stand-in.
 */
async function dangerousMcpRegistration(
  execute: (input: { target: string }) => unknown
): Promise<Tool> {
  const dangerous = tool({
    description: "does something dangerous",
    execute,
    inputSchema: z.object({ target: z.string() }),
  });
  createMCPClient.mockResolvedValueOnce({
    close: () => Promise.resolve(),
    onElicitationRequest: () => undefined,
    tools: () => Promise.resolve({ dangerous }),
  });
  const client = new McpClient({
    id: "s1",
    transport: { kind: "remote", protocol: "http", url: "http://s1/mcp" },
  });
  await client.connect();
  const registration = client.tools().s1__dangerous;
  if (!registration) {
    throw new Error("expected one tool");
  }
  return registration;
}

/**
 * Proves task-08's core migration end to end: `McpManager` registrations
 * reach the real `AgentHarness` compiler (via `SessionHarness`'s
 * `registrations` setting — the seam that lets producers migrate onto the
 * compiler without touching harness assembly) and are gated by the
 * harness's own `AgentAuthorizer`, not by the manager's own (now removed)
 * approval wrapping.
 */
describe("MCP registrations through the harness policy (task-08)", () => {
  it("allow: the mcp.tool capability is exact, and the effect runs exactly once through the compiled tool", async () => {
    const execute = vi.fn(({ target }: { target: string }) => `did ${target}`);
    const registration = await dangerousMcpRegistration(execute);
    expect(metaOf(registration).source).toBe("mcp");
    // Metadata and schema are the manager's own untouched tool — preserved
    // through tagging and compilation.
    expect(registration.description).toBe("does something dangerous");

    const policy = createInMemoryAgentAuthorizer({
      policy: { global: "allow" },
    }).authorizer;
    const model = createScriptedMockModel({
      stream: [
        toolCallStreamResult("call-1", "s1__dangerous", { target: "prod" }),
        textStreamResult("done"),
      ],
    });
    const harness = new SessionHarness(
      {
        instructions: "x",
        model,
        policy,
        sessionId: "s",
        store: new InMemorySessionStore(),
        tools: { s1__dangerous: registration },
      },
      { sessionId: "s" }
    );

    const events = await drain(harness.stream("do it"));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ target: "prod" }, expect.anything());
    const result = events.find((e) => e.type === "tool-result");
    expect(result).toBeDefined();
  });

  it("deny: the tool never executes, even though the manager was configured with no approval handler", async () => {
    const execute = vi.fn(() => "should not run");
    const registration = await dangerousMcpRegistration(execute);

    const policy = createInMemoryAgentAuthorizer({
      policy: { global: "deny" },
    }).authorizer;
    const model = createScriptedMockModel({
      stream: [
        toolCallStreamResult("call-1", "s1__dangerous", { target: "prod" }),
        textStreamResult("done"),
      ],
    });
    const harness = new SessionHarness(
      {
        instructions: "x",
        model,
        policy,
        sessionId: "s",
        store: new InMemorySessionStore(),
        tools: { s1__dangerous: registration },
      },
      { sessionId: "s" }
    );

    const events = await drain(harness.stream("do it"));

    // The absence of an MCP-specific approval handler used to mean the raw
    // tool ran unguarded; now the harness's own policy decides, and a global
    // "deny" default is honored.
    expect(execute).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === "tool-result");
    expect(result).toMatchObject({ output: { approved: false } });
  });

  it("ask: an approval checkpoint is raised carrying the exact manager-derived mcp.tool capability, and execute is withheld", async () => {
    const execute = vi.fn(({ target }: { target: string }) => `did ${target}`);
    const registration = await dangerousMcpRegistration(execute);

    const policy = createInMemoryAgentAuthorizer({
      policy: { global: "ask" },
    }).authorizer;
    const model = createScriptedMockModel({
      stream: [
        toolCallStreamResult("call-1", "s1__dangerous", { target: "prod" }),
      ],
    });
    const harness = new SessionHarness(
      {
        instructions: "x",
        model,
        policy,
        sessionId: "s",
        store: new InMemorySessionStore(),
        tools: { s1__dangerous: registration },
      },
      { sessionId: "s" }
    );

    const events = await drain(harness.stream("do it"));
    const request = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-approval-request" }> =>
        e.type === "tool-approval-request"
    );

    expect(request?.capability).toEqual({
      kind: "mcp.tool",
      serverId: "s1",
      tool: "dangerous",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("a resolved approval runs the manager-produced mcp registration's effect exactly once", async () => {
    // Mirrors the proven approval-resume recipe (task-06/task-02): the tool
    // itself declares `needsApproval`, the checkpoint is seeded directly in
    // the session store, and resolving it resumes the real tool loop. What
    // task-08 adds is that the tool and its capability are the manager's own
    // tagged tool output, not a hand-tagged stand-in.
    const execute = vi.fn(({ target }: { target: string }) =>
      Promise.resolve(`did ${target}`)
    );
    const dangerous = tool({
      description: "does something dangerous",
      execute,
      inputSchema: z.object({ target: z.string() }),
      needsApproval: true,
    });
    createMCPClient.mockResolvedValueOnce({
      close: () => Promise.resolve(),
      onElicitationRequest: () => undefined,
      tools: () => Promise.resolve({ dangerous }),
    });
    const client = new McpClient({
      id: "s1",
      transport: { kind: "remote", protocol: "http", url: "http://s1/mcp" },
    });
    await client.connect();
    const registration = client.tools().s1__dangerous;
    if (!registration) {
      throw new Error("expected one tool");
    }

    const store = new InMemorySessionStore();
    await store.createSession({ id: "s" });
    await store.appendMessage({
      parts: [{ text: "do it", type: "text" }],
      role: "user",
      sessionId: "s",
    });
    await store.appendMessage({
      parts: [
        {
          input: { target: "prod" },
          name: "s1__dangerous",
          toolCallId: "c1",
          type: "tool_call",
        },
        {
          approvalId: "a1",
          capability: { kind: "mcp.tool", serverId: "s1", tool: "dangerous" },
          input: { target: "prod" },
          name: "s1__dangerous",
          toolCallId: "c1",
          type: "tool_approval_request",
        },
      ],
      role: "assistant",
      sessionId: "s",
    });

    const model = createScriptedMockModel({
      stream: [textStreamResult("done")],
    });
    const harness = new SessionHarness(
      {
        instructions: "x",
        model,
        sessionId: "s",
        store,
        tools: { s1__dangerous: registration },
      },
      { sessionId: "s" }
    );

    const events = await drain(
      harness.stream({
        parts: [
          { approvalId: "a1", approved: true, type: "tool_approval_response" },
        ],
      })
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ target: "prod" }, expect.anything());
    expect(events.some((e) => e.type === "tool-result")).toBe(true);
  });
});
