/**
 * The pre-turn token estimator (context.md §2). Cheap, deterministic, no
 * network — used only to decide "send as-is vs summarize" before a turn runs.
 * Actual reported usage is the real source of truth and corrects this over time.
 *
 * This is intentionally rough: the budget's `safetyMargin` absorbs its error.
 */
import type { SessionMessage, SessionPart, TokenCounter } from "./types";

/** ~4 chars per token is the standard back-of-envelope for English text. */
const CHARS_PER_TOKEN = 4;
/** Flat cost for an inline image — a real count needs the provider's tiler. */
const IMAGE_TOKENS = 768;
/** Per-message envelope (role, delimiters) the provider adds around content. */
const MESSAGE_OVERHEAD = 4;

function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function serializedTokens(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  return textTokens(JSON.stringify(value));
}

function partTokens(part: SessionPart): number {
  switch (part.type) {
    case "text":
    case "reasoning":
      return textTokens(part.text);
    case "image":
      return IMAGE_TOKENS;
    case "tool_call":
      return textTokens(part.name) + serializedTokens(part.input);
    case "tool_result":
      return serializedTokens(part.output);
    case "error":
      return textTokens(part.message);
    case "tool_approval_request":
      return textTokens(part.name) + serializedTokens(part.input);
    case "tool_approval_response":
      return part.reason ? textTokens(part.reason) : 0;
  }
}

/** Estimate tokens for a single message, content + envelope. */
export function estimateMessageTokens(message: SessionMessage): number {
  let total = MESSAGE_OVERHEAD;
  for (const part of message.parts) {
    total += partTokens(part);
  }
  return total;
}

/** The default {@link TokenCounter}: the heuristic estimator above. */
export const estimatingCounter: TokenCounter = {
  count: estimateMessageTokens,
};
