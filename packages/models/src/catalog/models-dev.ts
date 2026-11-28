import type {
  ModelCapabilities,
  ModelCosts,
  ModelCostTier,
  ModelLimits,
  ProviderModelDefinition,
} from "../model-definition";

interface ModelsDevCost {
  cache_read?: number;
  cache_write?: number;
  input: number;
  output: number;
  tiers?: {
    input: number;
    output: number;
    cache_read?: number;
    tier: { type: string; size: number };
  }[];
}

interface ModelsDevModel {
  attachment?: boolean;
  cost?: ModelsDevCost;
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
}

export type ModelsDevCatalog = Record<string, ModelsDevModel>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function firstPartyCost(
  key: string,
  model: Record<string, unknown>,
  providers: Record<string, unknown>
): ModelsDevCost | undefined {
  if (model.open_weights === true) {
    return;
  }
  const slash = key.indexOf("/");
  if (slash === -1) {
    return;
  }
  const provider = providers[key.slice(0, slash)];
  const models = isObject(provider) ? provider.models : undefined;
  const entry = isObject(models) ? models[key.slice(slash + 1)] : undefined;
  return isObject(entry) ? validCost(entry.cost) : undefined;
}

const isRate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const optionalRate = (value: unknown): boolean =>
  value === undefined || isRate(value);

function validCost(value: unknown): ModelsDevCost | undefined {
  if (
    !(
      isObject(value) &&
      isRate(value.input) &&
      isRate(value.output) &&
      optionalRate(value.cache_read) &&
      optionalRate(value.cache_write)
    )
  ) {
    return;
  }
  const tiers: NonNullable<ModelsDevCost["tiers"]> = [];
  if (value.tiers !== undefined) {
    if (!Array.isArray(value.tiers)) {
      return;
    }
    for (const tier of value.tiers) {
      const bracket = isObject(tier) ? tier.tier : undefined;
      if (
        !(
          isObject(tier) &&
          isRate(tier.input) &&
          isRate(tier.output) &&
          optionalRate(tier.cache_read) &&
          isObject(bracket) &&
          isRate(bracket.size) &&
          typeof bracket.type === "string"
        )
      ) {
        return;
      }
      tiers.push({
        input: tier.input,
        output: tier.output,
        ...(tier.cache_read === undefined
          ? {}
          : { cache_read: tier.cache_read as number }),
        tier: { size: bracket.size, type: bracket.type },
      });
    }
  }
  return {
    input: value.input,
    output: value.output,
    ...(value.cache_read === undefined
      ? {}
      : { cache_read: value.cache_read as number }),
    ...(value.cache_write === undefined
      ? {}
      : { cache_write: value.cache_write as number }),
    ...(tiers.length > 0 ? { tiers } : {}),
  };
}

function pruned(
  key: string,
  model: Record<string, unknown>,
  providers: Record<string, unknown>
): ModelsDevModel {
  const { limit, modalities } = model;
  const cost = firstPartyCost(key, model, providers);
  return {
    ...(typeof model.name === "string" ? { name: model.name } : {}),
    ...(model.attachment === true ? { attachment: true } : {}),
    ...(model.reasoning === true ? { reasoning: true } : {}),
    ...(model.tool_call === true ? { tool_call: true } : {}),
    ...(isObject(modalities) && Array.isArray(modalities.input)
      ? { modalities: modalities as ModelsDevModel["modalities"] }
      : {}),
    ...(isObject(limit)
      ? {
          limit: {
            ...(typeof limit.context === "number"
              ? { context: limit.context }
              : {}),
            ...(typeof limit.output === "number"
              ? { output: limit.output }
              : {}),
          },
        }
      : {}),
    ...(cost ? { cost } : {}),
  };
}

export function modelsDevCatalog(
  payload: unknown
): ModelsDevCatalog | undefined {
  if (!(isObject(payload) && isObject(payload.models))) {
    return;
  }
  const providers = isObject(payload.providers) ? payload.providers : {};
  const catalog: ModelsDevCatalog = {};
  for (const [key, model] of Object.entries(payload.models)) {
    if (isObject(model)) {
      catalog[key] = pruned(key, model, providers);
    }
  }
  return catalog;
}

export interface ModelsDevIdOptions {
  stripPrefixes?: readonly string[];
  stripSuffixes?: readonly string[];
}

export interface ModelsDevIndex {
  byBare: Map<string, string[]>;
  byPath: Map<string, string>;
  catalog: ModelsDevCatalog;
}

function canon(value: string): string {
  return value
    .toLowerCase()
    .replace(/[._]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function indexModelsDev(catalog: ModelsDevCatalog): ModelsDevIndex {
  const byPath = new Map<string, string>();
  const byBare = new Map<string, string[]>();
  for (const key of Object.keys(catalog)) {
    byPath.set(canon(key), key);
    const slash = key.indexOf("/");
    if (slash === -1) {
      continue;
    }
    const bare = canon(key.slice(slash + 1));
    byBare.set(bare, [...(byBare.get(bare) ?? []), key]);
  }
  return { byBare, byPath, catalog };
}

export function matchModelsDevId(
  def: Pick<ProviderModelDefinition, "id" | "modelId" | "vendor">,
  index: ModelsDevIndex,
  options?: ModelsDevIdOptions
): string | undefined {
  const attempt = (modelId: string): string | undefined => {
    if (modelId.includes("/")) {
      const hit = index.byPath.get(canon(modelId));
      if (hit) {
        return hit;
      }
    }
    if (def.vendor) {
      const hit = index.byPath.get(canon(`${def.vendor}/${modelId}`));
      if (hit) {
        return hit;
      }
    }
    const bare = index.byBare.get(canon(modelId));
    if (bare?.length === 1) {
      return bare[0];
    }
    return undefined;
  };

  const direct = attempt(def.modelId);
  if (direct) {
    return direct;
  }

  let stripped = def.modelId;
  for (const prefix of options?.stripPrefixes ?? []) {
    if (stripped.startsWith(prefix)) {
      stripped = stripped.slice(prefix.length);
    }
  }
  for (const suffix of options?.stripSuffixes ?? []) {
    if (stripped.endsWith(suffix)) {
      stripped = stripped.slice(0, -suffix.length);
    }
  }
  return stripped === def.modelId ? undefined : attempt(stripped);
}

function toTiers(
  base: number,
  tiers: NonNullable<ModelsDevCost["tiers"]>,
  pick: (t: NonNullable<ModelsDevCost["tiers"]>[number]) => number
): ModelCostTier[] {
  const sorted = [...tiers].sort((a, b) => a.tier.size - b.tier.size);
  const brackets: ModelCostTier[] = [];
  let rate = base;
  let floor = 0;
  for (const tier of sorted) {
    brackets.push({
      costPer1M: rate,
      maxTokens: tier.tier.size,
      minTokens: floor,
    });
    rate = pick(tier);
    floor = tier.tier.size;
  }
  brackets.push({ costPer1M: rate, minTokens: floor });
  return brackets;
}

function sameSchedule(costs: ModelCosts, meta: ModelsDevCost): boolean {
  const close = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);
  return close(costs.input, meta.input) && close(costs.output, meta.output);
}

function mergeCosts(
  existing: ModelCosts | undefined,
  meta: ModelsDevCost | undefined
): ModelCosts | undefined {
  if (!meta) {
    return existing;
  }
  if (!existing) {
    return {
      input: meta.input,
      output: meta.output,
      ...(meta.cache_read === undefined
        ? {}
        : { cachedInput: meta.cache_read }),
      ...(meta.cache_write === undefined
        ? {}
        : { cacheWrite: meta.cache_write }),
      ...(meta.tiers?.length
        ? {
            inputTiers: toTiers(meta.input, meta.tiers, (t) => t.input),
            outputTiers: toTiers(meta.output, meta.tiers, (t) => t.output),
          }
        : {}),
    };
  }
  if (!sameSchedule(existing, meta)) {
    return existing;
  }
  return {
    ...existing,
    ...(existing.cachedInput === undefined && meta.cache_read !== undefined
      ? { cachedInput: meta.cache_read }
      : {}),
    ...(existing.cacheWrite === undefined && meta.cache_write !== undefined
      ? { cacheWrite: meta.cache_write }
      : {}),
    ...(existing.inputTiers === undefined && meta.tiers?.length
      ? { inputTiers: toTiers(meta.input, meta.tiers, (t) => t.input) }
      : {}),
    ...(existing.outputTiers === undefined && meta.tiers?.length
      ? { outputTiers: toTiers(meta.output, meta.tiers, (t) => t.output) }
      : {}),
  };
}

function mergeLimits(
  existing: ModelLimits | undefined,
  meta: ModelsDevModel["limit"]
): ModelLimits | undefined {
  if (!meta) {
    return existing;
  }
  const merged: ModelLimits = {
    ...existing,
    ...(existing?.maxInputTokens === undefined && meta.context !== undefined
      ? { maxInputTokens: meta.context }
      : {}),
    ...(existing?.maxOutputTokens === undefined && meta.output !== undefined
      ? { maxOutputTokens: meta.output }
      : {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeCapabilities(
  existing: ModelCapabilities | undefined,
  model: ModelsDevModel
): ModelCapabilities | undefined {
  const merged: ModelCapabilities = {
    ...existing,
    ...(existing?.functionCalling === undefined && model.tool_call === true
      ? { functionCalling: true }
      : {}),
    ...(existing?.reasoning === undefined && model.reasoning === true
      ? { reasoning: true }
      : {}),
    ...(existing?.vision === undefined &&
    model.modalities?.input?.includes("image")
      ? { vision: true }
      : {}),
    ...(existing?.fileInput === undefined && model.attachment === true
      ? { fileInput: true }
      : {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function enrichFromModelsDev(
  defs: ProviderModelDefinition[],
  catalog: ModelsDevCatalog,
  options?: ModelsDevIdOptions
): ProviderModelDefinition[] {
  const index = indexModelsDev(catalog);
  return defs.map((def) => {
    const key = matchModelsDevId(def, index, options);
    if (key === undefined) {
      return def;
    }
    const model = index.catalog[key];
    if (!model) {
      return def;
    }

    const costs = mergeCosts(def.costs, model.cost);
    const limits = mergeLimits(def.limits, model.limit);
    const capabilities = mergeCapabilities(def.capabilities, model);
    return {
      ...def,
      ...(def.label === undefined && model.name !== undefined
        ? { label: model.name }
        : {}),
      ...(costs ? { costs } : {}),
      ...(limits ? { limits } : {}),
      ...(capabilities ? { capabilities } : {}),
    };
  });
}
