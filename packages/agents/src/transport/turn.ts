import type { UIMessageChunk } from "ai";

import { z } from "zod";

import type { SessionHarness } from "../harness";
import type { SessionInput, SessionMessage, SessionUsage } from "../session";

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

export const sessionTurnShape = {
  attachments: z.array(ImageAttachment).optional(),
  content: z.string().default(""),
  harness: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  toolResults: z.array(ToolResult).optional(),
};

export type SessionTurnInput = z.infer<z.ZodObject<typeof sessionTurnShape>>;

/** A turn must carry *something*: user text, an attachment, or tool results. */
export function turnHasInput(v: SessionTurnInput): boolean {
  return (
    v.content.trim().length > 0 ||
    (v.attachments?.length ?? 0) > 0 ||
    (v.toolResults?.length ?? 0) > 0
  );
}

/** Project turn delta to harness input: tool_results when resuming, else user text + images. */
export function toSessionInput(input: SessionTurnInput): SessionInput {
  if (input.toolResults && input.toolResults.length > 0) {
    return {
      parts: input.toolResults.map((r) => ({
        output: r.output,
        toolCallId: r.toolCallId,
        type: "tool_result" as const,
        ...(r.isError ? { isError: true } : {}),
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
  /**
   * Run after each turn settles — e.g. to accumulate session totals. The store
   * itself has no `updateTotals`, so the caller supplies that side effect (DB or
   * otherwise), keeping this helper persistence-agnostic.
   */
  onFinish?: (event: { message: SessionMessage; usage: SessionUsage }) => void;
  /**
   * Aborts the in-flight turn. Pass a subscription's `signal` — it fires when
   * the renderer unsubscribes (the stop button), so the harness cancels the
   * underlying model request instead of generating on into a closed stream.
   */
  signal?: AbortSignal;
}

/**
 * Drive one turn of a harness agent and yield it as `useChat` UIMessageChunks.
 * The single seam a `useChat` router streams through: resolve your agent, pass
 * the turn delta, `yield*` the result from inside the router's subscription
 * generator.
 *
 * The caller wraps the subscription's whole generator in {@link
 * import("./stream").freshIterable} before returning it — a *native* async
 * generator already carries `Symbol.asyncDispose`, and some subscription
 * transports throw trying to attach their own, so the plain `freshIterable`
 * object must be what crosses the subscription boundary.
 */
export async function* streamSessionAgent(
  agent: SessionHarness,
  input: SessionTurnInput,
  options: StreamSessionOptions = {}
): AsyncGenerator<UIMessageChunk> {
  const stream = agent.stream(toSessionInput(input), {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(options.onFinish ? { onFinish: options.onFinish } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  yield* projectToUIMessageChunks(stream, {
    ...(input.model === undefined ? {} : { model: input.model }),
  });
}
