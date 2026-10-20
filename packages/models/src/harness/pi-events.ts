import type { StreamPart } from "@foundry/agents/harness";
import { executePiTool } from "./pi-tools";
import { type DriverRun, type ReportTool, record } from "./shared";

interface PiEventOptions {
  close(): void;
  finish(error?: Error): void;
  push(part: StreamPart): void;
  report: ReportTool;
  run: DriverRun;
  send(message: Record<string, unknown>): Promise<void>;
}

/** agent_end is intermediate: retries and compaction may still continue until agent_settled. */
export function createPiEvents(options: PiEventOptions) {
  let turns = 0;
  let messageIndex = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let failed = false;
  let stopReason = "stop";
  const nativeCalls = new Map<
    string,
    { input: unknown; toolCallId: string; toolName: string }
  >();

  const receiveTool = async (event: Record<string, unknown>) => {
    if (
      event.method !== "input" ||
      (event.title !== "foundry.execute" &&
        event.title !== "foundry.permission") ||
      typeof event.placeholder !== "string"
    ) {
      await options.send({
        canceled: true,
        id: event.id,
        type: "extension_ui_response",
      });
      return;
    }
    const request = record(JSON.parse(event.placeholder));
    if (
      typeof request.toolName !== "string" ||
      typeof request.toolCallId !== "string"
    ) {
      throw new Error("Invalid Pi host tool request.");
    }
    const call = {
      input: request.input,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
    };
    const result =
      event.title === "foundry.permission"
        ? await nativePermission(call)
        : await executePiTool(options.run, options.report, call);
    await options.send({
      id: event.id,
      type: "extension_ui_response",
      value: JSON.stringify(result),
    });
  };
  const nativePermission = async (call: {
    input: unknown;
    toolCallId: string;
    toolName: string;
  }) => {
    await options.report({ ...call, outcome: "started" });
    options.run.signal.throwIfAborted();
    const permission = await options.run.permission({
      ...call,
      sessionId: options.run.sessionId,
      signal: options.run.signal,
    });
    if (permission.behavior === "deny") {
      await options.report({
        ...call,
        outcome: "refused",
        reason: permission.message,
      });
      return { success: false, text: permission.message };
    }
    if (permission.updatedInput !== undefined) {
      await options.report({
        ...call,
        outcome: "refused",
        reason: "Native Pi tools cannot replace approved input.",
      });
      return {
        success: false,
        text: "Use a host tool when approval changes the input.",
      };
    }
    nativeCalls.set(call.toolCallId, call);
    return { success: true, text: "approved" };
  };
  const receiveText = (event: Record<string, unknown>) => {
    const update = record(event.assistantMessageEvent);
    const id = `${messageIndex}:${String(update.contentIndex ?? 0)}`;
    switch (update.type) {
      case "text_delta":
      case "thinking_delta":
        if (typeof update.delta === "string") {
          options.push({
            id,
            text: update.delta,
            type:
              update.type === "text_delta" ? "text-delta" : "reasoning-delta",
          });
        }
        break;
      case "text_end":
      case "thinking_end":
        options.push({
          id,
          type: update.type === "text_end" ? "text-end" : "reasoning-end",
        });
        break;
      default:
        break;
    }
  };
  const receiveMessage = (event: Record<string, unknown>) => {
    const message = record(event.message);
    if (message.role !== "assistant") {
      return;
    }
    const usage = record(message.usage);
    input += tokenCount(usage.input);
    output += tokenCount(usage.output);
    cacheRead += tokenCount(usage.cacheRead);
    cacheWrite += tokenCount(usage.cacheWrite);
    stopReason =
      typeof message.stopReason === "string" ? message.stopReason : "stop";
    failed = stopReason === "error";
  };
  const settle = (aborted: boolean) => {
    if (failed) {
      options.finish(
        new Error("Pi turn failed; raw provider diagnostics are withheld.")
      );
      return;
    }
    if (aborted || stopReason === "aborted") {
      options.push({ reason: "Pi turn interrupted.", type: "abort" });
    } else {
      options.push({
        finishReason: stopReason === "length" ? "length" : "stop",
        rawFinishReason: stopReason,
        totalUsage: {
          inputTokenDetails: {
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            noCacheTokens: input,
          },
          inputTokens: input + cacheRead + cacheWrite,
          outputTokenDetails: {
            reasoningTokens: undefined,
            textTokens: output,
          },
          outputTokens: output,
          totalTokens: input + cacheRead + cacheWrite + output,
        },
        type: "finish",
      });
    }
    options.finish();
  };
  return {
    async receive(event: Record<string, unknown>) {
      switch (event.type) {
        case "extension_ui_request":
          await receiveTool(event);
          break;
        case "turn_start":
          turns += 1;
          if (turns > options.run.profile.maxSteps) {
            options.finish(new Error("Pi exceeded the harness turn limit."));
            options.close();
          }
          break;
        case "message_start":
          messageIndex += 1;
          break;
        case "message_update":
          receiveText(event);
          break;
        case "tool_execution_end": {
          const call = nativeCalls.get(String(event.toolCallId));
          if (call) {
            nativeCalls.delete(call.toolCallId);
            await options.report({
              ...call,
              outcome: event.isError ? "failed" : "ran",
            });
          }
          break;
        }
        case "message_end":
          receiveMessage(event);
          break;
        case "agent_settled":
          settle(event.aborted === true);
          break;
        default:
          break;
      }
    },
  };
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
