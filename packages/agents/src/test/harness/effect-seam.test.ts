import type { ToolExecutionOptions } from "ai";

import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type {
  AgentAuthorizationDecision,
  AgentAuthorizer,
} from "../../authorization";
import { compileRegistrations } from "../../harness/tool-compiler";
import type { RegisteredToolCall, ToolEffectPort } from "../../harness/types";
import { registrationsOf } from "../../harness/types";
import { fakeAuthorizer } from "../helpers/authorizer";

// Every real tool execute crosses the harness's approval/effect seam exactly
// once (agent tool request -> effect port -> policy -> the tool), never a
// second path. The tool under test is deliberately inert: the seam is what is
// checked, not what the tool does.

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

function allowPolicy(): AgentAuthorizer {
  return fakeAuthorizer(() => ({ kind: "allow", source: "grant" }));
}

function echoTool() {
  const execute = vi.fn(({ text }: { text: string }) => text);
  return {
    execute,
    tools: {
      echo: tool({
        description: "echo",
        execute,
        inputSchema: z.object({ text: z.string() }),
      }),
    },
  };
}

const opts: ToolExecutionOptions<unknown> = {
  context: undefined,
  messages: [],
  toolCallId: "call-1",
};

describe("tool effect seam", () => {
  it("crosses the approval/effect seam exactly once per tool call", async () => {
    const { tools, execute } = echoTool();
    const { port, calls } = fakeEffectPort();
    const compiled = compileRegistrations(registrationsOf(tools, "declared"), {
      agentId: "a1",
      effectPort: port,
      policy: allowPolicy(),
    });

    const out: unknown = await compiled.tools.echo?.execute?.(
      { text: "hi" },
      opts
    );

    expect(out).toBe("hi");
    expect(execute).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolCallId: "call-1", toolName: "echo" });
  });

  it("denies without ever reaching the tool when policy denies", async () => {
    const { tools, execute } = echoTool();
    const { port, calls } = fakeEffectPort();
    const denyDecision: AgentAuthorizationDecision = {
      kind: "deny",
      reason: "no access",
      source: "policy",
    };
    const compiled = compileRegistrations(registrationsOf(tools, "declared"), {
      agentId: "a1",
      effectPort: port,
      policy: fakeAuthorizer(() => denyDecision),
    });

    const out: unknown = await compiled.tools.echo?.execute?.(
      { text: "hi" },
      opts
    );

    expect(out).toEqual({ approved: false, reason: "no access" });
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
