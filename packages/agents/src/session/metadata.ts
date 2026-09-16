import type { MessageMetadata, SessionUsage } from "./types";

/**
 * The loosely-typed metadata blob a store hands back before normalization —
 * structurally what any backend persists for a message (model id/provider,
 * token usage, timing). Deliberately tolerant of `null` and unknown extra
 * fields so a concrete store's row type assigns to it without a cast.
 */
export interface RawMessageMetadata {
  model?: { id: string; provider?: string; harness?: string } | null;
  notification?: { taskId: string; kind: "status" | "completion" } | null;
  timing?: {
    startedAt: number;
    completedAt: number;
    durationMs: number;
  } | null;
  usage?: RawUsage | null;
}

/** The token-usage shape a store reads back, before it's narrowed to {@link SessionUsage}. */
export interface RawUsage {
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
}

/**
 * Project a store's raw metadata blob onto the canonical {@link MessageMetadata},
 * deep-picking exactly the known model / usage / timing fields and dropping the
 * rest. Store-agnostic: every persistent backend reads back the same canonical
 * shape, so this field-by-field normalization lives here once rather than being
 * re-implemented in each adapter. Returns `undefined` for an absent blob so it
 * drops cleanly out of an exactOptionalPropertyTypes object spread.
 */
export function normalizeMessageMetadata(
  raw: RawMessageMetadata | null | undefined
): MessageMetadata | undefined {
  if (!raw) {
    return undefined;
  }
  const usage = normalizeUsage(raw.usage);
  return {
    ...(raw.model ? { model: raw.model } : {}),
    ...(usage ? { usage } : {}),
    ...(raw.timing
      ? {
          timing: {
            completedAt: raw.timing.completedAt,
            durationMs: raw.timing.durationMs,
            startedAt: raw.timing.startedAt,
          },
        }
      : {}),
    ...(raw.notification ? { notification: raw.notification } : {}),
  };
}

/** Narrow a store's raw usage to {@link SessionUsage}, keeping only known token fields. */
export function normalizeUsage(
  raw: RawUsage | null | undefined
): SessionUsage | undefined {
  if (!raw) {
    return undefined;
  }
  return {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    totalTokens: raw.totalTokens,
    ...(raw.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: raw.reasoningTokens }),
    ...(raw.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: raw.cachedInputTokens }),
    ...(raw.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: raw.cacheWriteTokens }),
  };
}
