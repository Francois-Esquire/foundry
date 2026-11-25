import { z } from "zod";
import type {
  ModelCapabilities,
  ModelCosts,
  ModelCostTier,
  ModelKind,
  ModelLimits,
  ProviderModelDefinition,
} from "../../model-definition";

function tokenLimits(
  maxInputTokens: number | null | undefined,
  maxOutputTokens: number | null | undefined
): ModelLimits | undefined {
  const limits = {
    ...(maxInputTokens === null || maxInputTokens === undefined
      ? {}
      : { maxInputTokens }),
    ...(maxOutputTokens === null || maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens }),
  };
  return Object.keys(limits).length > 0 ? limits : undefined;
}

const TIER = z.object({
  cost: z.string(),
  max: z.number().optional(),
  min: z.number().optional(),
});

const PRICING = z.object({
  input: z.string().optional(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
  input_tiers: z.array(TIER).optional(),
  output: z.string().optional(),
  output_tiers: z.array(TIER).optional(),
});

const MODEL = z.object({
  context_window: z.number().optional(),
  description: z.string().optional(),
  id: z.string().min(1),
  max_tokens: z.number().optional(),
  name: z.string().optional(),
  owned_by: z.string().optional(),
  pricing: PRICING.optional(),
  tags: z.array(z.string()).optional(),
  type: z.string().optional(),
});

const MODELS = z.array(MODEL);
const LIST = z.union([z.object({ data: MODELS }), MODELS]);

type VercelRestPricingTier = z.infer<typeof TIER>;
type VercelRestPricing = z.infer<typeof PRICING>;
export type VercelRestModel = z.infer<typeof MODEL>;

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
  return models.flatMap((model) => {
    const definition = vercelDefinition(model);
    return definition === undefined ? [] : [definition];
  });
}

export function parseVercelRest(
  payload: unknown
): ProviderModelDefinition[] | undefined {
  const parsed = LIST.safeParse(payload);
  return parsed.success ? fromVercelRest(parsed.data) : undefined;
}

function vercelDefinition(
  model: VercelRestModel
): ProviderModelDefinition | undefined {
  if (!(model.type && Object.hasOwn(KIND_BY_TYPE, model.type) && model.id)) {
    return undefined;
  }
  const kind = KIND_BY_TYPE[model.type] as ModelKind;

  const costs = normalizeCosts(model.pricing);
  const capabilities = normalizeTags(model.tags);
  const limits = tokenLimits(model.context_window, model.max_tokens);
  return {
    id: model.id,
    kind,
    modelId: model.id,
    ...(model.name ? { label: model.name } : {}),
    ...(model.description ? { description: model.description } : {}),
    ...(model.owned_by ? { vendor: model.owned_by } : {}),
    ...(costs ? { costs } : {}),
    ...(limits ? { limits } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

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
    minTokens: tier.min ?? 0,
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
    if (Object.hasOwn(CAPABILITY_BY_TAG, tag)) {
      const key = CAPABILITY_BY_TAG[tag] as keyof ModelCapabilities;
      capabilities[key] = true;
    }
  }
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}
