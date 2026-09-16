import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  AgentAuthorizationRequest,
  AgentAuthorizer,
} from "../../authorization";
import { AgentHarness, SessionHarness, tagTool } from "../../harness";
import { toolAuthorizationContext } from "../../harness/tool-compiler";
import type { SessionEvent } from "../../session";
import { InMemorySessionStore } from "../../session";
import { fakeAuthorizer } from "../helpers/authorizer";
import {
  createScriptedMockModel,
  textStreamResult,
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

/** An allow-everything policy that records every request it sees, so a test
 *  can inspect which `source` a compiled tool call actually carried. */
function recordingAllowPolicy(): {
  policy: AgentAuthorizer;
  requests: AgentAuthorizationRequest[];
} {
  const requests: AgentAuthorizationRequest[] = [];
  return {
    policy: fakeAuthorizer((request) => {
      requests.push(request);
      return { kind: "allow", source: "grant" };
    }),
    requests,
  };
}

/** A trivial no-input, no-effect tool for assembly-only tests. */
function noopTool(description: string) {
  return tool({
    description,
    execute: () => "ok",
    inputSchema: z.object({}),
  });
}

describe("SessionHarness — mesh tool attribution", () => {
  it('compiles mesh tools tagged source "mesh", not "declared"', async () => {
    const { policy, requests } = recordingAllowPolicy();
    const model = createScriptedMockModel({
      stream: [
        toolCallStreamResult("call-1", "list_agents", {}),
        textStreamResult("done"),
      ],
    });

    const harness = new SessionHarness(
      {
        instructions: "x",
        model,
        policy,
        sessionId: "s1",
        store: new InMemorySessionStore(),
      },
      { sessionId: "s1" }
    );

    await drain(harness.stream("hi"));

    const seen = requests
      .map((r) => toolAuthorizationContext(r))
      .find((c) => c?.tool.name === "list_agents");
    expect(seen?.tool.source).toBe("mesh");
  });
});

describe("AgentHarness — duplicate tool name precedence", () => {
  it("the later entry in the tools map wins on a duplicate name, tagged or not", () => {
    const harness = new AgentHarness(
      {
        instructions: "x",
        model: createScriptedMockModel({}),
        tools: {
          ...{ dup: noopTool("first") },
          ...{ dup: tagTool(noopTool("second"), { source: "skill" }) },
        },
      },
      { sessionId: "" }
    );

    expect(harness.agent.tools.dup?.description).toBe("second");
  });

  it("mesh tools win over a caller's tool of the same name", () => {
    const harness = new SessionHarness(
      {
        instructions: "x",
        model: createScriptedMockModel({}),
        tools: { list_agents: noopTool("mine") },
      },
      { sessionId: "" }
    );

    expect(harness.agent.tools.list_agents?.description).not.toBe("mine");
  });
});
