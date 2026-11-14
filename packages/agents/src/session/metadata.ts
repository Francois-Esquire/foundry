import type { LanguageModelUsage } from "ai";

import type { MessageMetadata, SessionUsage } from "./types";

/**
 * The metadata blob a store hands back before normalization: every
 * {@link MessageMetadata} field, each also allowed to be `null`, so a concrete
 * store's row type assigns to it without a cast.
 */
export type RawMessageMetadata = {
  [Field in keyof MessageMetadata]?: MessageMetadata[Field] | null;
};

/** The token usage a store reads back. */
export type RawUsage = SessionUsage;

/**
 * Project a store's raw metadata blob onto the canonical {@link MessageMetadata},
 * deep-picking exactly the known model / usage / timing / output fields and dropping the
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
  if (raw.output !== undefined) {
    metadata.output = raw.output;
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
