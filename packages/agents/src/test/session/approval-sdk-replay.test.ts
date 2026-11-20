import { generateText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { toModelMessages } from "../../session/converter";
import type { SessionMessage, SessionPart } from "../../session/types";
import {
  textGenerateResult,
  toolCallGenerateResult,
} from "../helpers/mock-language-model";

function msg(
  id: string,
  role: SessionMessage["role"],
  parts: SessionPart[]
): SessionMessage {
  return {
    createdAt: 0,
    id,
    parts,
    role,
    sessionId: "s1",
    status: "complete",
    updatedAt: 0,
  };
}

describe("installed AI SDK approval replay", () => {
  it("accepts a replayed 'always' approval even after the live grant store already allows the tool", async () => {
    let alwaysGranted = false;
    const execute = vi.fn(async ({ target }: { target: string }) =>
      Promise.resolve(`did ${target}`)
    );

    const dangerousTool = tool({
      description: "does something dangerous",
      execute,
      inputSchema: z.object({ target: z.string() }),
      needsApproval: () => !alwaysGranted,
    });

    const requestingModel = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve(
          toolCallGenerateResult("call-1", "dangerous", { target: "prod" })
        ),
    });

    const first = await generateText({
      messages: [{ content: "do it", role: "user" }],
      model: requestingModel,
      tools: { dangerous: dangerousTool },
    });

    const request = first.content.find(
      (part) => part.type === "tool-approval-request"
    );
    if (!request) {
      throw new Error("expected a tool-approval-request");
    }
    expect(request.toolCall.toolCallId).toBe("call-1");
    expect(execute).not.toHaveBeenCalled();

    alwaysGranted = true;

    const history: SessionMessage[] = [
      msg("m1", "user", [{ text: "do it", type: "text" }]),
      msg("m2", "assistant", [
        {
          input: { target: "prod" },
          name: "dangerous",
          toolCallId: "call-1",
          type: "tool_call",
        },
        {
          approvalId: request.approvalId,
          capability: { kind: "mcp.tool", serverId: "s", tool: "dangerous" },
          input: { target: "prod" },
          name: "dangerous",
          toolCallId: "call-1",
          type: "tool_approval_request",
        },
      ]),
      msg("m3", "tool", [
        {
          approvalId: request.approvalId,
          approved: true,
          scope: "always",
          type: "tool_approval_response",
        },
      ]),
    ];

    const replayed = await toModelMessages(history, {
      dangerous: dangerousTool,
    });

    const finishingModel = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(textGenerateResult("done")),
    });

    const second = await generateText({
      messages: replayed,
      model: finishingModel,
      tools: { dangerous: dangerousTool },
    });

    expect(execute).toHaveBeenCalledWith({ target: "prod" }, expect.anything());
    expect(second.text).toBe("done");
  });

  it("control: an explicit denial still stops a replayed approval from executing", async () => {
    const execute = vi.fn(async () => Promise.resolve("done"));
    const trivialTool = tool({
      description: "trivial",
      execute,
      inputSchema: z.object({ target: z.string() }),
    });

    const history: SessionMessage[] = [
      msg("m1", "user", [{ text: "do it", type: "text" }]),
      msg("m2", "assistant", [
        {
          input: { target: "x" },
          name: "trivial",
          toolCallId: "call-2",
          type: "tool_call",
        },
        {
          approvalId: "approval-2",
          capability: { kind: "mcp.tool", serverId: "s", tool: "trivial" },
          input: { target: "x" },
          name: "trivial",
          toolCallId: "call-2",
          type: "tool_approval_request",
        },
      ]),
      msg("m3", "tool", [
        {
          approvalId: "approval-2",
          approved: true,
          type: "tool_approval_response",
        },
      ]),
    ];

    const replayed = await toModelMessages(history, { trivial: trivialTool });

    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(textGenerateResult("done")),
    });

    await generateText({
      messages: replayed,
      model,
      toolApproval: { trivial: "denied" },
      tools: { trivial: trivialTool },
    });

    expect(execute).not.toHaveBeenCalled();
  });
});
