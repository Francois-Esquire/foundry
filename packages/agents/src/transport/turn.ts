import type { UIMessageChunk } from "ai";

import { z } from "zod";

import type { SessionHarness } from "../harness/session-harness";
import type { SessionMessage, SessionUsage } from "../schema";
import type { SessionInput } from "../session/events";

import { projectToUIMessageChunks } from "./ui-stream";

const ImageAttachment = z.object({
  mediaType: z.string().optional(),
  url: z.string().min(1),
});

const ToolResult = z.object({
  isError: z.boolean().optional(),
  output: z.unknown(),
  toolCallId: z.string(),
});

const sessionTurnShape = {
  attachments: z.array(ImageAttachment).optional(),
  content: z.string().default(""),
  harness: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  toolResults: z.array(ToolResult).optional(),
};

export type SessionTurnInput = z.infer<z.ZodObject<typeof sessionTurnShape>>;

export function turnHasInput(v: SessionTurnInput): boolean {
  return (
    v.content.trim().length > 0 ||
    (v.attachments?.length ?? 0) > 0 ||
    (v.toolResults?.length ?? 0) > 0
  );
}

export function toSessionInput(input: SessionTurnInput): SessionInput {
  if (input.toolResults && input.toolResults.length > 0) {
    return {
      parts: input.toolResults.map((r) => ({
        isError: r.isError,
        output: r.output,
        toolCallId: r.toolCallId,
        type: "tool_result" as const,
      })),
    };
  }

  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return input.content;
  }
  return {
    parts: [
      ...(input.content.trim().length > 0
        ? [{ text: input.content, type: "text" as const }]
        : []),
      ...attachments.map((a) => ({
        type: "image" as const,
        url: a.url,
        ...(a.mediaType ? { mediaType: a.mediaType } : {}),
      })),
    ],
  };
}

export interface StreamSessionOptions {
  onFinish?: (event: { message: SessionMessage; usage: SessionUsage }) => void;
  signal?: AbortSignal;
}

export async function* streamSessionAgent(
  agent: SessionHarness,
  input: SessionTurnInput,
  options: StreamSessionOptions = {}
): AsyncGenerator<UIMessageChunk> {
  const stream = agent.stream(toSessionInput(input), {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    onFinish: options.onFinish,
    signal: options.signal,
  });

  yield* projectToUIMessageChunks(stream, { model: input.model });
}
