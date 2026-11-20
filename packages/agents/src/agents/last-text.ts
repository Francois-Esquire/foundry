import type { UIMessage, UIMessageChunk } from "ai";

import { isTextUIPart, readUIMessageStream } from "ai";

export function lastTextValue(
  message: UIMessage | undefined,
  fallback: string
): string {
  const part = [...(message?.parts ?? [])].reverse().find(isTextUIPart);
  const text = part?.text ?? "";
  return text.length > 0 ? text : fallback;
}

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
