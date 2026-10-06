import type { LanguageModelUsage } from "ai";

import type { MessageMetadata, SessionUsage } from "./types";

/**
 * The loosely-typed metadata blob a store hands back before normalization —
 * structurally what any backend persists for a message (model id/provider,
 * token usage, timing). Deliberately tolerant of `null` and unknown extra
 * fields so a concrete store's row type assigns to it without a cast.
 */
export interface RawMessageMetadata {
  harnessEnvironment?: { harness: string; id: string } | null;
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
 * shape, including the harness environment identity, so this normalization
 * lives here once rather than being re-implemented in each adapter. Returns
 * `undefined` for an absent blob.
 */
export function normalizeMessageMetadata(
  raw: RawMessageMetadata | null | undefined
): MessageMetadata | undefined {
  if (!raw) {
    return undefined;
  }
  const metadata: MessageMetadata = {};
  if (raw.harnessEnvironment) {
    const { harness, id } = raw.harnessEnvironment;
    metadata.harnessEnvironment = { harness, id };
  }
  if (raw.model) {
    metadata.model = raw.model;
  }
  if (raw.usage) {
    const {
      cachedInputTokens,
      cacheWriteTokens,
      inputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
    } = raw.usage;
    const usage: SessionUsage = { inputTokens, outputTokens, totalTokens };
    if (cachedInputTokens !== undefined) {
      usage.cachedInputTokens = cachedInputTokens;
    }
    if (cacheWriteTokens !== undefined) {
      usage.cacheWriteTokens = cacheWriteTokens;
    }
    if (reasoningTokens !== undefined) {
      usage.reasoningTokens = reasoningTokens;
    }
    metadata.usage = usage;
  }
  if (raw.timing) {
    const { completedAt, durationMs, startedAt } = raw.timing;
    metadata.timing = { completedAt, durationMs, startedAt };
  }
  if (raw.notification) {
    metadata.notification = raw.notification;
  }
  return metadata;
}

/**
 * Narrow the AI SDK's turn usage to {@link SessionUsage}. Absent counts read
 * as zero, a missing total as input plus output, and the cache and reasoning
 * details are kept only when non-zero.
 */
export function normalizeUsage(usage: LanguageModelUsage): SessionUsage {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const result: SessionUsage = {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens || inputTokens + outputTokens,
  };
  const { cacheReadTokens, cacheWriteTokens } = usage.inputTokenDetails;
  const { reasoningTokens } = usage.outputTokenDetails;
  if (reasoningTokens) {
    result.reasoningTokens = reasoningTokens;
  }
  if (cacheReadTokens) {
    result.cachedInputTokens = cacheReadTokens;
  }
  if (cacheWriteTokens) {
    result.cacheWriteTokens = cacheWriteTokens;
  }
  return result;
}
