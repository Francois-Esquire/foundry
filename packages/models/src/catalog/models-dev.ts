/**
 * models.dev — a community-maintained database of model facts, used to fill in
 * what a routing provider doesn't tell us.
 *
 * The problem it solves: every source we route through reports a different
 * subset. The gateway snapshot has prices but no cache rates and no modalities;
 * a CLI harness reports bare slugs and nothing else. Hand-writing the remainder
 * is what rots. models.dev keys facts by model id, independent of who serves it,
 * which is exactly the missing axis.
 *
 * **It never overrides.** A field the provider stated wins, always — this only
 * fills absences. Its prices are published vendor list prices, not your bill,
 * and it is community data: treat it as a good default, never as authority over
 * a rate the provider itself reported.
 *
 * Pure leaf, like its sibling adapters — it imports only `../types`, and takes
 * the catalog as an argument rather than loading the snapshot. See
 * `./models-dev-snapshot` for the bound convenience.
 */

import type {
  ModelCapabilities,
  ModelCosts,
  ModelCostTier,
  ModelLimits,
  ProviderModelDefinition,
} from "../types";

/** Rates in USD per 1M tokens — already per-million upstream, unlike the wire
 *  formats `fromGateway`/`fromVercelRest` read, which are per-token. */
export interface ModelsDevCost {
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

export interface ModelsDevModel {
  attachment?: boolean;
  cost?: ModelsDevCost;
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
}

/** Keyed `author/model`, e.g. `anthropic/claude-opus-4-7`. */
export type ModelsDevCatalog = Record<string, ModelsDevModel>;

export interface ModelsDevIdOptions {
  /** Route decorations to strip from the front of an id, e.g. `["azure-"]`. */
  stripPrefixes?: readonly string[];
  /** Route decorations to strip from the end, e.g. `["-useast"]`. */
  stripSuffixes?: readonly string[];
}

export interface ModelsDevIndex {
  /** canonical bare name → real keys (plural: a shared name is unresolvable) */
  byBare: Map<string, string[]>;
  /** canonical full path → real key */
  byPath: Map<string, string>;
  catalog: ModelsDevCatalog;
}

/**
 * Fold away the separator conventions different sources use for the same model:
 * OpenAI writes versions with dots (`gpt-5.5`), models.dev keys them with
 * dashes (`gpt-5-5`), LiteLLM sometimes uses underscores. No two distinct real
 * models differ only by that separator, so collapsing them cannot collide.
 */
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

/**
 * The models.dev key for a catalog row, or undefined.
 *
 * Exact matching only. There is no edit distance, no substring search, no
 * date-suffix or `-latest` stripping — a *near* miss stays a miss, because a
 * wrong match injects wrong pricing and wrong capabilities into surfaces the
 * user reads as fact. Concretely: LiteLLM's `gpt-5-chat` is the non-tool-calling
 * endpoint, and models.dev's `gpt-5-chat-latest` is not the same model; letting
 * those match would put a model in the picker that fails on its first tool call.
 *
 * Claude Code's aliases (`opus`, `sonnet`, …) never match, and must not: an
 * alias resolves to whatever the CLI picks today, so pinning it to a dated build
 * reintroduces exactly the staleness this catalog exists to remove — and the
 * harness is a subscription seat, so per-token rates would render a number that
 * is not real. They miss for free (the index holds no such bare key); the test
 * pins it so nobody "fixes" that later.
 */
export function matchModelsDevId(
  def: Pick<ProviderModelDefinition, "id" | "modelId" | "vendor">,
  index: ModelsDevIndex,
  options?: ModelsDevIdOptions
): string | undefined {
  const attempt = (modelId: string): string | undefined => {
    // 1. Already a path — Vercel gateway ids are literally models.dev keys.
    if (modelId.includes("/")) {
      const hit = index.byPath.get(canon(modelId));
      if (hit) {
        return hit;
      }
    }
    // 2. Vendor as author. Only fires when the vendor really names an author,
    //    so route names (`azure`, `vertex_ai`, `bedrock`) yield nothing.
    if (def.vendor) {
      const hit = index.byPath.get(canon(`${def.vendor}/${modelId}`));
      if (hit) {
        return hit;
      }
    }
    // 3. Bare name — only when exactly one author claims it. Two authors
    //    sharing a name is not resolvable, and guessing is how wrong prices land.
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

  // 4. Retry without this deployment's own route decorations. Opt-in: the
  //    caller owns its naming convention, this package must not guess it.
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

/** Tier brackets, min-inclusive and max-exclusive, with the base rate as tier 0
 *  — the shape `costFromUsage`'s `tierRate` walks. */
function toTiers(
  base: number,
  tiers: NonNullable<ModelsDevCost["tiers"]>,
  pick: (t: NonNullable<ModelsDevCost["tiers"]>[number]) => number
): ModelCostTier[] {
  // A models.dev tier reads "above this size, the rate becomes X" — so the base
  // rate owns everything below the first threshold, and each tier owns the span
  // from its own size up to the next one.
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

/**
 * Whether models.dev is describing the same price schedule the provider is.
 *
 * Its cache rates and tiers are absolute figures, not multipliers, so grafting
 * them onto a row whose base rate came from somewhere else would silently mix
 * two schedules. When the bases disagree — a negotiated rate, a reseller markup,
 * a re-priced regional deployment — we fill nothing rather than guess.
 */
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
    // No price at all — take the vendor list price whole. `input`/`output` are
    // a required pair, so there is no half-fill to worry about.
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
  // `limit.context` is the total window, which is what `maxInputTokens` means
  // here — the context meter sizes itself from it. `limit.input` (a separate,
  // smaller "max input" some models publish) is deliberately not used.
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
  // Per key, and only where the provider said nothing. An explicit `false`
  // survives — `fromGateway` distinguishes stated-false from silent precisely
  // so a community flag can never contradict a provider that spoke.
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

/**
 * Fill absent fields on catalog rows from models.dev. Rows with no match are
 * returned by identity — not re-spread — so a miss is provably inert.
 *
 * Applies to rows from metered API routes. Subscription-seat harnesses
 * (Claude Code, Codex) get facts but must not get pricing; their catalogs carry
 * no `costs`, and their ids don't match anything priced.
 */
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
