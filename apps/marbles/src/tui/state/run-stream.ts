import type { ChannelMessage } from "@foundry/workflows/channels";

export const STREAM_TAIL_LINES = 12;
const MAX_CHARS = 20_000;

function under(path: readonly string[], stepId?: string): boolean {
  if (stepId === undefined) {
    return true;
  }
  const key = path.join(".");
  return key === stepId || key.startsWith(`${stepId}.`);
}

export function streamDelta(
  message: ChannelMessage,
  stepId?: string
): string | undefined {
  if (
    message._tag === "chunk" &&
    message.chunk.payload.kind === "text" &&
    under(message.chunk.path, stepId)
  ) {
    return message.chunk.payload.text;
  }
}

export function appendStream(text: string, delta: string): string {
  return (text + delta).slice(-MAX_CHARS);
}

export function streamTail(text: string): string[] {
  return text.split("\n").slice(-STREAM_TAIL_LINES);
}
