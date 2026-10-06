import type { LanguageModelUsage } from "ai";

import type { StreamPart } from "../../harness/stream-transform";

/** Typed AI SDK v7 stream parts, so a test names only the fields it is about. */

export function textDelta(text: string, id = "text-1"): StreamPart {
  return { id, text, type: "text-delta" };
}

export function reasoningDelta(text: string, id = "reasoning-1"): StreamPart {
  return { id, text, type: "reasoning-delta" };
}

export function toolCall(
  toolCallId: string,
  toolName: string,
  input: unknown
): Extract<StreamPart, { type: "tool-call" }> {
  return { input, toolCallId, toolName, type: "tool-call" };
}

export function toolResult(
  toolCallId: string,
  output: unknown,
  preliminary?: boolean
): StreamPart {
  return {
    input: {},
    output,
    preliminary,
    toolCallId,
    toolName: "tool",
    type: "tool-result",
  };
}

export function usage(
  counts: Partial<
    Pick<LanguageModelUsage, "inputTokens" | "outputTokens" | "totalTokens">
  > & {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  } = {}
): LanguageModelUsage {
  return {
    inputTokenDetails: {
      cacheReadTokens: counts.cacheReadTokens,
      cacheWriteTokens: counts.cacheWriteTokens,
      noCacheTokens: undefined,
    },
    inputTokens: counts.inputTokens,
    outputTokenDetails: {
      reasoningTokens: counts.reasoningTokens,
      textTokens: undefined,
    },
    outputTokens: counts.outputTokens,
    totalTokens: counts.totalTokens,
  };
}

export function finish(totalUsage = usage()): StreamPart {
  return {
    finishReason: "stop",
    rawFinishReason: undefined,
    totalUsage,
    type: "finish",
  };
}
