import type { SessionMessage, SessionPart } from "../schema";
import type { TokenCounter } from "./types";

const CHARS_PER_TOKEN = 4;
const IMAGE_TOKENS = 768;
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
    case "harness_activity":
    case "harness_question":
    case "harness_session":
    case "harness_tool":
      return 0;
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
    default:
      break;
  }
  return undefined as never;
}

function estimateMessageTokens(message: SessionMessage): number {
  let total = MESSAGE_OVERHEAD;
  for (const part of message.parts) {
    total += partTokens(part);
  }
  return total;
}

export const estimatingCounter: TokenCounter = {
  count: estimateMessageTokens,
};
