import type {
  ModelCapabilities,
  ModelCosts,
  ModelCostTier,
  ModelKind,
  ProviderModelDefinition,
} from "../types";

export interface VercelRestPricingTier {
  cost: string;
  max?: number;
  min: number;
}

export interface VercelRestPricing {
  input?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  input_tiers?: VercelRestPricingTier[];
  output?: string;
  output_tiers?: VercelRestPricingTier[];
}

export interface VercelRestModel {
  context_window?: number;
  description?: string;
  id: string;
  max_tokens?: number;
  name?: string;
  owned_by?: string;
  pricing?: VercelRestPricing;
  tags?: string[];
  type?: string;
}

export interface VercelRestModelList {
  data: VercelRestModel[];
}

const KIND_BY_TYPE: Record<string, ModelKind> = {
  embedding: "embedding",
  image: "image",
  language: "text",
};

const CAPABILITY_BY_TAG: Record<string, keyof ModelCapabilities> = {
  "file-input": "fileInput",
  reasoning: "reasoning",
  "tool-use": "functionCalling",
  vision: "vision",
  "web-search": "webSearch",
};

export function fromVercelRest(
  payload: VercelRestModelList | VercelRestModel[]
): ProviderModelDefinition[] {
  const models = Array.isArray(payload) ? payload : payload.data;
  const rows: ProviderModelDefinition[] = [];
  for (const model of models) {
    const kind = KIND_BY_TYPE[model.type ?? ""];
    if (!(kind && model.id)) {
      continue;
    }

    const costs = normalizeCosts(model.pricing);
    const capabilities = normalizeTags(model.tags);
    const limits = {
      ...(model.context_window == null
        ? {}
        : { maxInputTokens: model.context_window }),
      ...(model.max_tokens == null
        ? {}
        : { maxOutputTokens: model.max_tokens }),
    };

    rows.push({
      id: model.id,
      kind,
      modelId: model.id,
      ...(model.name ? { label: model.name } : {}),
      ...(model.description ? { description: model.description } : {}),
      ...(model.owned_by ? { vendor: model.owned_by } : {}),
      ...(costs ? { costs } : {}),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
      ...(capabilities ? { capabilities } : {}),
    });
  }
  return rows;
}

/** Parse a per-token decimal string into USD per 1M tokens. */
function per1M(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const perToken = Number.parseFloat(value);
  if (!Number.isFinite(perToken)) {
    return undefined;
  }
  return perToken * 1_000_000;
}

function normalizeTier(tier: VercelRestPricingTier): ModelCostTier | null {
  const costPer1M = per1M(tier.cost);
  if (costPer1M === undefined) {
    return null;
  }
  return {
    costPer1M,
    minTokens: tier.min,
    ...(tier.max === undefined ? {} : { maxTokens: tier.max }),
  };
}

function normalizeTiers(
  tiers: VercelRestPricingTier[] | undefined
): ModelCostTier[] | undefined {
  if (!tiers || tiers.length === 0) {
    return undefined;
  }
  const normalized = tiers
    .map(normalizeTier)
    .filter((t): t is ModelCostTier => t !== null);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeCosts(
  pricing: VercelRestPricing | undefined
): ModelCosts | undefined {
  if (!pricing) {
    return undefined;
  }
  const input = per1M(pricing.input);
  const output = per1M(pricing.output);
  // Without both base rates the pricing is unusable for estimation — omit
  // rather than fabricate zeros that would read as "free".
  if (input === undefined || output === undefined) {
    return undefined;
  }

  const cachedInput = per1M(pricing.input_cache_read);
  const cacheWrite = per1M(pricing.input_cache_write);
  const inputTiers = normalizeTiers(pricing.input_tiers);
  const outputTiers = normalizeTiers(pricing.output_tiers);

  return {
    input,
    output,
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(inputTiers ? { inputTiers } : {}),
    ...(outputTiers ? { outputTiers } : {}),
  };
}

function normalizeTags(
  tags: string[] | undefined
): ModelCapabilities | undefined {
  if (!tags || tags.length === 0) {
    return undefined;
  }
  const capabilities: ModelCapabilities = {};
  for (const tag of tags) {
    const key = CAPABILITY_BY_TAG[tag];
    if (key) {
      capabilities[key] = true;
    }
  }
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}
