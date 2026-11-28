import type { LanguageModelUsage } from "ai";

import type { MessageMetadata, SessionUsage } from "../schema";

type NormalizedMetadata = Omit<MessageMetadata, "providerOptions">;

export type RawMessageMetadata = {
  [Field in keyof NormalizedMetadata]?: NormalizedMetadata[Field] | null;
};

export type RawUsage = SessionUsage;

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
