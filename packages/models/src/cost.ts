import type { ModelCosts, ModelCostTier } from "./types";

const PER_MILLION = 1_000_000;

/**
 * Pick the per-1M rate for a tiered price. Gateway tiers (Vercel/Qwen/Gemini
 * style) are bracketed by the *prompt size* — `selectorTokens` is the gross
 * input token count — and the matching tier's rate applies to both input and
 * output (the input and output tier arrays share the same brackets). Brackets
 * are min-inclusive, max-exclusive; the open-ended top tier omits `maxTokens`.
 * Falls back to `flat` when no tier brackets the count.
 */
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

/**
 * A turn's token counts, in the provider's reported shape. `inputTokens` is the
 * _gross_ prompt size — it already includes the cache read/write tokens, which
 * are reported separately so they can be billed at their own rates.
 */
export interface CostUsageCounts {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

/** Per-category cost in USD. `total` is the sum. */
export interface CostBreakdown {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  reasoning: number;
  total: number;
}

/**
 * Cost in USD from a model's catalog rates (USD per 1M tokens) and a turn's
 * token usage.
 *
 * `inputTokens` is treated as gross: the cache read/write portions are split
 * out and billed at their own rates (cache reads are cheaper, cache writes
 * dearer), and only the remainder bills at the standard input rate — so cache
 * tokens are never double-charged. Reasoning bills at the output rate. When the
 * catalog omits a cache rate it falls back to the input rate.
 *
 * Tiered models (`inputTiers`/`outputTiers`, e.g. Vercel-gateway long-context
 * pricing) select a rate by the gross prompt size and bill input *and* output
 * at that tier; models without tiers use the flat top-level rate.
 */
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

/**
 * The cost Claude Code reported for one model call: the CLI's
 * `total_cost_usd`, which `ai-sdk-provider-claude-code` puts on the call's
 * provider metadata as `costUsd`. The CLI computes it from its own price
 * table on any login, so it is an estimate, not a bill. On a call that
 * resumed a session it includes that session's earlier spend.
 */
export function claudeCodeCostUsd(
  metadata: Readonly<Record<string, unknown>> | undefined
): number | undefined {
  const entry = metadata?.["claude-code"];
  const cost =
    typeof entry === "object" && entry !== null
      ? (entry as { costUsd?: unknown }).costUsd
      : undefined;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0
    ? cost
    : undefined;
}
