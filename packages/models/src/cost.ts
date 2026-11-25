import type { ModelCosts, ModelCostTier } from "./model-definition";

const PER_MILLION = 1_000_000;

function tierRate(
  tiers: ModelCostTier[] | undefined,
  selectorTokens: number,
  flat: number
): number {
  if (!tiers || tiers.length === 0) {
    return flat;
  }
  for (const tier of tiers) {
    if (
      selectorTokens >= tier.minTokens &&
      (tier.maxTokens === undefined || selectorTokens < tier.maxTokens)
    ) {
      return tier.costPer1M;
    }
  }
  return flat;
}

export interface CostUsageCounts {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export interface CostBreakdown {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  reasoning: number;
  total: number;
}

export function costFromUsage(
  costs: ModelCosts,
  usage: CostUsageCounts
): CostBreakdown {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const grossInput = usage.inputTokens ?? 0;
  const uncachedInput = Math.max(
    0,
    grossInput - cacheReadTokens - cacheWriteTokens
  );

  const inputRate = tierRate(costs.inputTiers, grossInput, costs.input);
  const outputRate = tierRate(costs.outputTiers, grossInput, costs.output);

  const input = (uncachedInput / PER_MILLION) * inputRate;
  const output = ((usage.outputTokens ?? 0) / PER_MILLION) * outputRate;
  const reasoning = ((usage.reasoningTokens ?? 0) / PER_MILLION) * outputRate;
  const cacheRead =
    (cacheReadTokens / PER_MILLION) * (costs.cachedInput ?? inputRate);
  const cacheWrite =
    (cacheWriteTokens / PER_MILLION) * (costs.cacheWrite ?? inputRate);

  return {
    cacheRead,
    cacheWrite,
    input,
    output,
    reasoning,
    total: input + output + reasoning + cacheRead + cacheWrite,
  };
}

export const CLAUDE_CODE_FRESH = { field: "claudeCodeFresh", key: "foundry" };

export function claudeCodeCallCost(
  metadata: Readonly<Record<string, unknown>> | undefined
): number | undefined {
  const field = (key: string, name: string): unknown => {
    const entry = metadata?.[key];
    return typeof entry === "object" && entry !== null
      ? (entry as Record<string, unknown>)[name]
      : undefined;
  };
  if (field(CLAUDE_CODE_FRESH.key, CLAUDE_CODE_FRESH.field) !== true) {
    return;
  }
  const cost = field("claude-code", "costUsd");
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0
    ? cost
    : undefined;
}
