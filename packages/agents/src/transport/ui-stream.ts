import { randomUUID } from "node:crypto";
import type { LanguageModelUsage, UIMessageChunk } from "ai";

import type { SessionStream } from "../session/events";
import type { SessionUsage } from "../session/types";

export interface ProjectOptions {
  /** Resolved model id, surfaced in the leading `start` chunk's metadata. */
  model?: string;
}

/** Project harness SessionStream to AI SDK UIMessageChunk protocol for useChat. */
export async function* projectToUIMessageChunks(
  stream: SessionStream,
  opts: ProjectOptions = {}
): AsyncGenerator<UIMessageChunk> {
  yield {
    type: "start",
    ...(opts.model ? { messageMetadata: { model: { id: opts.model } } } : {}),
  };
  // Per-turn step boundary for pause/resume: tracks which tool results are new
  yield { type: "start-step" };

  const runs: OpenRuns = { reasoningId: null, textId: null };

  for await (const event of stream) {
    switch (event.type) {
      case "text-delta": {
        yield* projectTextDelta(event, runs);
        break;
      }
      case "reasoning-delta": {
        yield* projectReasoningDelta(event, runs);
        break;
      }
      case "tool-call": {
        yield* closeRuns(runs);
        yield {
          input: event.input,
          toolCallId: event.toolCallId,
          toolName: event.name,
          type: "tool-input-available",
        };
        break;
      }
      case "tool-result": {
        yield* projectToolResult(event);
        break;
      }
      case "tool-approval-request": {
        yield* closeRuns(runs);
        yield {
          approvalId: event.approvalId,
          signature: event.signature,
          toolCallId: event.toolCallId,
          type: "tool-approval-request",
        };
        break;
      }
      case "error": {
        yield* closeRuns(runs);
        yield { errorText: event.error.message, type: "error" };
        break;
      }
      case "finish": {
        yield* closeRuns(runs);
        yield { type: "finish-step" };
        yield {
          messageMetadata: { usage: toUiUsage(event.usage) },
          type: "finish",
        };
        break;
      }
      default:
        break;
    }
  }
}

interface OpenRuns {
  reasoningId: string | null;
  textId: string | null;
}

/** Close open text/reasoning runs before boundaries. */
function* closeRuns(runs: OpenRuns): Generator<UIMessageChunk> {
  if (runs.textId !== null) {
    yield { id: runs.textId, type: "text-end" };
    runs.textId = null;
  }
  if (runs.reasoningId !== null) {
    yield { id: runs.reasoningId, type: "reasoning-end" };
    runs.reasoningId = null;
  }
}

function* projectTextDelta(
  event: { delta: string },
  runs: OpenRuns
): Generator<UIMessageChunk> {
  if (runs.reasoningId !== null) {
    yield { id: runs.reasoningId, type: "reasoning-end" };
    runs.reasoningId = null;
  }
  if (runs.textId === null) {
    runs.textId = randomUUID();
    yield { id: runs.textId, type: "text-start" };
  }
  yield { delta: event.delta, id: runs.textId, type: "text-delta" };
}

function* projectReasoningDelta(
  event: { delta: string },
  runs: OpenRuns
): Generator<UIMessageChunk> {
  if (runs.textId !== null) {
    yield { id: runs.textId, type: "text-end" };
    runs.textId = null;
  }
  if (runs.reasoningId === null) {
    runs.reasoningId = randomUUID();
    yield { id: runs.reasoningId, type: "reasoning-start" };
  }
  yield { delta: event.delta, id: runs.reasoningId, type: "reasoning-delta" };
}

function* projectToolResult(event: {
  isError?: boolean;
  output: unknown;
  toolCallId: string;
}): Generator<UIMessageChunk> {
  if (event.isError) {
    yield {
      errorText: stringifyOutput(event.output),
      toolCallId: event.toolCallId,
      type: "tool-output-error",
    };
    return;
  }
  yield {
    output: event.output,
    toolCallId: event.toolCallId,
    type: "tool-output-available",
  };
}

/**
 * Project the harness's flat {@link SessionUsage} onto the AI SDK's nested
 * {@link LanguageModelUsage} shape the UI reads. Cache and reasoning counts move
 * under `inputTokenDetails` / `outputTokenDetails` (the current, non-deprecated
 * fields); this is the only place cache-write can surface, since the flat shape
 * has no equivalent. Display-only — persistence keeps the flat `SessionUsage`.
 */
function toUiUsage(usage: SessionUsage): LanguageModelUsage {
  return {
    inputTokenDetails: {
      cacheReadTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      noCacheTokens: undefined,
    },
    inputTokens: usage.inputTokens,
    outputTokenDetails: {
      reasoningTokens: usage.reasoningTokens,
      textTokens: undefined,
    },
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
