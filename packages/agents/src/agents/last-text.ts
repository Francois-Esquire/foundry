import type { UIMessage, UIMessageChunk } from "ai";

import { isTextUIPart, readUIMessageStream } from "ai";

/**
 * The final text a sub-agent said: the last text part of its last message.
 * An absent message, no text part, or an empty text part all fall through to
 * `fallback` — the length test matters, since a reply that ends on a tool
 * result (no text) must not surface as an empty string.
 */
export function lastTextValue(
  message: UIMessage | undefined,
  fallback: string
): string {
  const part = [...(message?.parts ?? [])].reverse().find(isTextUIPart);
  const text = part?.text ?? "";
  return text.length > 0 ? text : fallback;
}

/**
 * Drive a sub-agent's UI-message stream to completion and return the final
 * text ({@link lastTextValue} of the last message). The single "collapse a
 * run to its reply" rule shared by the spawn tool, the agent-as-tool wrapper,
 * and the mesh.
 */
export async function collapseFinalText(
  stream: ReadableStream<UIMessageChunk>,
  fallback: string
): Promise<string> {
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) {
    last = message;
  }
  return lastTextValue(last, fallback);
}
