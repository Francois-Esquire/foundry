export type ProviderOptions = Record<string, Record<string, unknown>>;

export type CacheProvider = "anthropic" | "openai" | "google";

const OPENAI_REASONING_MODEL_PATTERN = /^o\d/;

export interface CacheDirectives {
  breakpoint?: ProviderOptions;
  request?: ProviderOptions;
}

interface CacheOverrides {
  anthropicTtl?: "5m" | "1h";
  disabled?: boolean;
}

export interface CacheRuleInput {
  cachedContent?: string;
  modelId?: string;
  overrides?: CacheOverrides;
  provider?: string;
  sessionId?: string;
}

export function resolveCacheProvider(
  input: Pick<CacheRuleInput, "provider" | "modelId">
): CacheProvider | null {
  const fromProvider = input.provider ? familyFromToken(input.provider) : null;
  if (fromProvider) {
    return fromProvider;
  }

  if (input.modelId) {
    const prefix = input.modelId.includes("/")
      ? input.modelId.slice(0, input.modelId.indexOf("/"))
      : input.modelId;
    return familyFromToken(prefix) ?? familyFromToken(input.modelId);
  }
  return null;
}

export function cacheDirectivesFor(input: CacheRuleInput): CacheDirectives {
  if (input.overrides?.disabled) {
    return {};
  }

  switch (resolveCacheProvider(input)) {
    case "anthropic": {
      const ttl = input.overrides?.anthropicTtl;
      const cacheControl = ttl
        ? { ttl, type: "ephemeral" }
        : { type: "ephemeral" };
      return { breakpoint: { anthropic: { cacheControl } } };
    }
    case "openai":
      return input.sessionId
        ? { request: { openai: { promptCacheKey: input.sessionId } } }
        : {};
    case "google":
      return input.cachedContent
        ? { request: { google: { cachedContent: input.cachedContent } } }
        : {};
    case null:
      return {};
    default:
      break;
  }
  return undefined as never;
}

export function mergeProviderOptions(
  base: ProviderOptions | undefined,
  add: ProviderOptions | undefined
): ProviderOptions | undefined {
  if (!add) {
    return base;
  }
  if (!base) {
    return add;
  }
  const out: ProviderOptions = { ...base };
  for (const [provider, opts] of Object.entries(add)) {
    out[provider] = { ...(out[provider] ?? {}), ...opts };
  }
  return out;
}

function familyFromToken(token: string): CacheProvider | null {
  const t = token.toLowerCase();
  if (t.includes("anthropic") || t.includes("claude")) {
    return "anthropic";
  }
  if (t.includes("google") || t.includes("gemini") || t.includes("vertex")) {
    return "google";
  }
  if (
    t.includes("openai") ||
    t.includes("gpt") ||
    OPENAI_REASONING_MODEL_PATTERN.test(t)
  ) {
    return "openai";
  }
  return null;
}
