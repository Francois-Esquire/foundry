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

/**
 * Installed-SDK integration test — the task's blocking gate (task-02). It
 * imports the real `ai` package (no hand-rolled approval stub) and pins what
 * the SDK does with a persisted approval that our own converter reconstructs
 * into AI SDK messages, the path every resumed Session takes:
 *
 *   approval request emitted for a toolCallId
 *   -> "always" recorded in the grant store
 *   -> persisted approval response replayed
 *   -> the SDK honors that approval and runs the call.
 *
 * ai v7 changed this contract. v6 re-resolved `needsApproval` on replay and
 * treated the approval as fabricated — denying it — whenever the tool no
 * longer asked for one, so a tool had to consult its own history for a prior
 * request on the same `toolCallId` ("sticky") to survive a replay at all. v7's
 * `validateApprovedToolApprovals` honors a replayed approval on its own and
 * denies only when approval resolution returns an explicit "denied"; forgery
 * defense moved to signing the request (`experimental_toolApprovalSecret`).
 *
 * Neither is what the harness leans on — compiled tools decide inside their
 * own `execute`, and `validateApprovalResponse` rejects a malformed,
 * duplicate, or mismatched response before it can reach history (covered in
 * `converter.test.ts`). What still has to hold here is narrower, and is what
 * these two tests pin: the converter's output is something the installed SDK
 * accepts, and that approval is genuinely evaluated rather than waved through.
 */

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

describe("installed AI SDK approval replay (task-02 blocking gate)", () => {
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

    // Turn 1: nothing is granted yet, so the real SDK issues an approval
    // request instead of executing.
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

    // The human resolves "always" *after* the request was already issued.
    alwaysGranted = true;

    // Persist the turn as Session parts, exactly as the harness would, then
    // replay them through our own converter — the same path a resumed
    // Session takes.
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

    // Turn 2: the live grant store now says the tool needs no approval, but
    // the SDK must still honor this already-issued, persisted approval.
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
    // Same replay shape, refused at the call level. Proves the approval above
    // is actually resolved on the way through rather than executing because
    // the SDK waves any replayed call past its approval check.
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
