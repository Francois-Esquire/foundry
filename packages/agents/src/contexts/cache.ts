/**
 * `contexts` caching — the per-provider cache rules, the sibling concern to
 * sizing (see `README.md` §2, §4, §8). Pure and provider-keyed: given the model
 * /provider resolved for a turn, decide which provider options to apply and
 * **where** — request-level vs the per-message breakpoint (the two seams, §4).
 *
 * No `ai` import, no store, no harness: this is the *rules*. The harness applies
 * what {@link cacheDirectivesFor} returns at the seams (request-level options on
 * the stream call; the breakpoint on the anchor message). Kept ai-package-free
 * with the same structural `providerOptions` shape used elsewhere.
 */

/** Structural provider-options bag (provider → key → value). */
export type ProviderOptions = Record<string, Record<string, unknown>>;

/** Provider families we have explicit cache rules for. */
export type CacheProvider = "anthropic" | "openai" | "google";

/**
 * What to apply, split by the two injection seams (§4):
 *  - `request` — request-level `providerOptions` (OpenAI `promptCacheKey`,
 *    Google explicit `cachedContent`). Set on the stream/generate call.
 *  - `breakpoint` — `providerOptions` to merge onto the **anchor** message part
 *    (Anthropic `cacheControl`). Marks the cached prefix.
 *
 * Either may be absent: OpenAI/Google ride the stable prefix automatically, so
 * their `request` entry is optional sugar; only Anthropic *requires* a directive.
 */
export interface CacheDirectives {
  breakpoint?: ProviderOptions;
  request?: ProviderOptions;
}

/** Per-agent overrides layered over the provider-family base rule. */
export interface CacheOverrides {
  /** Anthropic ephemeral TTL. Omit to use the provider default (5m). */
  anthropicTtl?: "5m" | "1h";
  /** Turn caching off for this agent/turn (emits no directives). */
  disabled?: boolean;
}

export interface CacheRuleInput {
  /** Pre-created Google `CachedContent` resource name (explicit caching). */
  cachedContent?: string;
  /** Model id. Its prefix is the provider family under gateway routing. */
  modelId?: string;
  /** Per-agent overrides. */
  overrides?: CacheOverrides;
  /** Explicit provider; used when it names a real family (not a gateway). */
  provider?: string;
  /** Stabilizes OpenAI cache routing — typically the session id. */
  sessionId?: string;
}

/**
 * Resolve the provider family from an explicit provider or the model id.
 *
 * Under gateway routing the active `provider` is often `"gateway"` while the
 * real family is the model-id prefix (e.g. `google/gemini-3.5-flash`). So we try
 * the explicit provider first, then the model-id prefix, then the whole id.
 * Returns `null` when no known family matches.
 */
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

/**
 * The rules. Map the resolved provider family to its cache directives, applying
 * any per-agent overrides. Pure — no I/O.
 */
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
      // Auto-caches on a stable prefix; the key only pins routing.
      return input.sessionId
        ? { request: { openai: { promptCacheKey: input.sessionId } } }
        : {};
    case "google":
      // Implicit caching needs nothing; explicit references a created resource.
      return input.cachedContent
        ? { request: { google: { cachedContent: input.cachedContent } } }
        : {};
    case null:
      return {};
  }
}

/**
 * Merge cache directives' provider options into an existing bag without
 * clobbering sibling keys — notably the Gemini `thoughtSignature` already on a
 * tool-call part (§4 merge hazard). Per-provider objects are shallow-merged.
 */
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

/** Match a provider/model token to a known family, by id prefix or model name. */
function familyFromToken(token: string): CacheProvider | null {
  const t = token.toLowerCase();
  if (t.includes("anthropic") || t.includes("claude")) {
    return "anthropic";
  }
  if (t.includes("google") || t.includes("gemini") || t.includes("vertex")) {
    return "google";
  }
  if (t.includes("openai") || t.includes("gpt") || /^o\d/.test(t)) {
    return "openai";
  }
  return null;
}
