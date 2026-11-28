import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createMemoryAuthorization } from "../../authorization/authorization";
import { createBuiltinCodingHarness } from "../../harness/builtin-coding";
import {
  createPermissiveAuthorization,
  denyAction,
} from "../helpers/authorizer";
import {
  createScriptedMockModel,
  textStreamResult,
  toolCallStreamResult,
} from "../helpers/mock-language-model";

async function coding(
  model: ReturnType<typeof createScriptedMockModel>,
  execute = vi.fn(async () => "checked"),
  maxSteps = 8
) {
  return createBuiltinCodingHarness(
    {
      agentId: "coder",
      authorization: await createPermissiveAuthorization(),
      compaction: { summarizer: { summarize: async () => "summary" } },
      maxSteps,
      model,
      tools: {
        bash: tool({ execute, inputSchema: z.object({ command: z.string() }) }),
      },
    },
    { sessionId: "coding" }
  );
}

describe("built-in coding composition", () => {
  it("executes injected tools through the existing session loop and records results", async () => {
    const model = createScriptedMockModel({
      stream: [
        toolCallStreamResult("call", "bash", { command: "bun test" }),
        textStreamResult("tests passed"),
      ],
    });
    const execute = vi.fn(async () => "checked");
    const harness = await coding(model, execute);
    const result = await harness.generate("run tests");
    expect(execute).toHaveBeenCalledOnce();
    expect(result.parts).toContainEqual({
      output: "checked",
      toolCallId: "call",
      type: "tool_result",
    });
    expect(result.parts).toContainEqual({ text: "tests passed", type: "text" });
    expect(model.doStreamCalls[0]?.prompt[0]).toMatchObject({
      content: expect.stringContaining("coding agent"),
      role: "system",
    });
    await expect(harness.steer("change scope")).rejects.toThrow(
      "does not support live steering"
    );
  });

  it("an injected live callback cannot bypass an explicit configured denial", async () => {
    const execute = vi.fn(async () => "checked");
    const permission = vi.fn(async () => ({ behavior: "allow" as const }));
    const model = createScriptedMockModel({
      stream: [
        toolCallStreamResult("call", "bash", { command: "bun test" }),
        textStreamResult("denied"),
      ],
    });
    const authorization = createMemoryAuthorization();
    await denyAction(
      authorization,
      "tool.call",
      "Denied by capability kind policy."
    );
    const harness = createBuiltinCodingHarness(
      {
        agentId: "coder",
        authorization,
        compaction: { summarizer: { summarize: async () => "summary" } },
        maxSteps: 8,
        model,
        permission,
        tools: {
          bash: tool({
            execute,
            inputSchema: z.object({ command: z.string() }),
          }),
        },
      },
      { sessionId: "coding" }
    );
    const result = await harness.generate("run tests");
    expect(permission).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.parts).toContainEqual({
      output: { approved: false, reason: "Denied by capability kind policy." },
      toolCallId: "call",
      type: "tool_result",
    });
  });

  it("honors the configured step limit", async () => {
    const model = createScriptedMockModel({
      stream: [
        toolCallStreamResult("call", "bash", { command: "bun test" }),
        textStreamResult("should not run"),
      ],
    });
    const harness = await coding(model, undefined, 1);
    await harness.generate("run tests");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("does not execute a tool denied by authorization", async () => {
    const execute = vi.fn(async () => "checked");
    const model = createScriptedMockModel({
      stream: [
        toolCallStreamResult("call", "bash", { command: "bun test" }),
        textStreamResult("denied"),
      ],
    });
    const authorization = createMemoryAuthorization();
    await denyAction(
      authorization,
      "tool.call",
      "Denied by capability kind policy."
    );
    const harness = createBuiltinCodingHarness(
      {
        agentId: "coder",
        authorization,
        compaction: { summarizer: { summarize: async () => "summary" } },
        maxSteps: 8,
        model,
        tools: {
          bash: tool({
            execute,
            inputSchema: z.object({ command: z.string() }),
          }),
        },
      },
      { sessionId: "coding" }
    );
    const result = await harness.generate("run tests");
    expect(execute).not.toHaveBeenCalled();
    expect(result.parts).toContainEqual({
      output: { approved: false, reason: "Denied by capability kind policy." },
      toolCallId: "call",
      type: "tool_result",
    });
  });
});
