import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentHarness } from "../../harness/agent-harness";
import { tagTool } from "../../harness/tool-registration";
import { createScriptedMockModel } from "../helpers/mock-language-model";

function noopTool(description: string) {
  return tool({
    description,
    execute: () => "ok",
    inputSchema: z.object({}),
  });
}

describe("AgentHarness — duplicate tool name precedence", () => {
  it("the later entry in the tools map wins on a duplicate name, tagged or not", () => {
    const harness = new AgentHarness({
      instructions: "x",
      model: createScriptedMockModel({}),
      tools: {
        ...{ dup: noopTool("first") },
        ...{ dup: tagTool(noopTool("second"), { source: "skill" }) },
      },
    });

    expect(harness.agent.tools.dup?.description).toBe("second");
  });
});
