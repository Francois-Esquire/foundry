import { randomUUID } from "node:crypto";
import type { LanguageModelUsage, UIMessageChunk } from "ai";

import type { SessionStream, SessionUsage } from "../session";

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

  let textId: string | null = null;
  let reasoningId: string | null = null;

  /** Close open text/reasoning runs before boundaries */
  function* closeRuns(): Generator<UIMessageChunk> {
    if (textId !== null) {
      yield { id: textId, type: "text-end" };
      textId = null;
    }
    if (reasoningId !== null) {
      yield { id: reasoningId, type: "reasoning-end" };
      reasoningId = null;
    }
  }

  for await (const event of stream) {
    switch (event.type) {
      case "text-delta": {
        if (reasoningId !== null) {
          yield { id: reasoningId, type: "reasoning-end" };
          reasoningId = null;
        }
        if (textId === null) {
          textId = randomUUID();
          yield { id: textId, type: "text-start" };
        }
        yield { delta: event.delta, id: textId, type: "text-delta" };
        break;
      }
      case "reasoning-delta": {
        if (textId !== null) {
          yield { id: textId, type: "text-end" };
          textId = null;
        }
        if (reasoningId === null) {
          reasoningId = randomUUID();
          yield { id: reasoningId, type: "reasoning-start" };
        }
        yield { delta: event.delta, id: reasoningId, type: "reasoning-delta" };
        break;
      }
      case "tool-call": {
        yield* closeRuns();
        yield {
          input: event.input,
          toolCallId: event.toolCallId,
          toolName: event.name,
          type: "tool-input-available",
        };
        break;
      }
      case "tool-result": {
        if (event.isError) {
          yield {
            errorText: stringifyOutput(event.output),
            toolCallId: event.toolCallId,
            type: "tool-output-error",
          };
        } else {
          yield {
            output: event.output,
            toolCallId: event.toolCallId,
            type: "tool-output-available",
          };
        }
        break;
      }
      case "tool-approval-request": {
        yield* closeRuns();
        yield {
          approvalId: event.approvalId,
          toolCallId: event.toolCallId,
          type: "tool-approval-request",
          ...(event.signature === undefined
            ? {}
            : { signature: event.signature }),
        };
        break;
      }
      case "error": {
        yield* closeRuns();
        yield { errorText: event.error.message, type: "error" };
        break;
      }
      case "finish": {
        yield* closeRuns();
        yield { type: "finish-step" };
        yield {
          messageMetadata: { usage: toUiUsage(event.usage) },
          type: "finish",
        };
        break;
      }
    }
  }
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
