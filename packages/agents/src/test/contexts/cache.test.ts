import { describe, expect, it } from "vitest";

import {
  cacheDirectivesFor,
  mergeProviderOptions,
  resolveCacheProvider,
} from "../../contexts/cache";

describe("resolveCacheProvider", () => {
  it("reads the family from an explicit provider", () => {
    expect(resolveCacheProvider({ provider: "anthropic" })).toBe("anthropic");
    expect(resolveCacheProvider({ provider: "openai" })).toBe("openai");
    expect(resolveCacheProvider({ provider: "google" })).toBe("google");
  });

  it("falls back to the model-id prefix under gateway routing", () => {
    // provider is the gateway, not a real family — parse the model id.
    expect(
      resolveCacheProvider({
        modelId: "google/gemini-3.5-flash",
        provider: "gateway",
      })
    ).toBe("google");
    expect(
      resolveCacheProvider({
        modelId: "anthropic/claude-opus-4-8",
        provider: "gateway",
      })
    ).toBe("anthropic");
  });

  it("matches by model name when there is no prefix", () => {
    expect(resolveCacheProvider({ modelId: "claude-opus-4-8" })).toBe(
      "anthropic"
    );
    expect(resolveCacheProvider({ modelId: "gemini-2.5-pro" })).toBe("google");
    expect(resolveCacheProvider({ modelId: "gpt-5" })).toBe("openai");
    expect(resolveCacheProvider({ modelId: "o3-mini" })).toBe("openai");
  });

  it("returns null for an unknown family", () => {
    expect(resolveCacheProvider({ provider: "gateway" })).toBeNull();
    expect(resolveCacheProvider({})).toBeNull();
  });
});

describe("cacheDirectivesFor", () => {
  it("emits an Anthropic ephemeral breakpoint (no request-level option)", () => {
    expect(cacheDirectivesFor({ provider: "anthropic" })).toEqual({
      breakpoint: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("honors an Anthropic ttl override", () => {
    expect(
      cacheDirectivesFor({
        overrides: { anthropicTtl: "1h" },
        provider: "anthropic",
      })
    ).toEqual({
      breakpoint: {
        anthropic: { cacheControl: { ttl: "1h", type: "ephemeral" } },
      },
    });
  });

  it("emits an OpenAI promptCacheKey from the session id (request-level)", () => {
    expect(
      cacheDirectivesFor({ provider: "openai", sessionId: "sess-1" })
    ).toEqual({ request: { openai: { promptCacheKey: "sess-1" } } });
  });

  it("emits nothing for OpenAI without a session id (auto-caches)", () => {
    expect(cacheDirectivesFor({ provider: "openai" })).toEqual({});
  });

  it("emits Google cachedContent only when an explicit cache is given", () => {
    expect(cacheDirectivesFor({ provider: "google" })).toEqual({});
    expect(
      cacheDirectivesFor({ cachedContent: "caches/abc", provider: "google" })
    ).toEqual({ request: { google: { cachedContent: "caches/abc" } } });
  });

  it("emits nothing when disabled, regardless of provider", () => {
    expect(
      cacheDirectivesFor({
        overrides: { disabled: true },
        provider: "anthropic",
      })
    ).toEqual({});
  });

  it("emits nothing for an unknown provider", () => {
    expect(cacheDirectivesFor({ provider: "gateway" })).toEqual({});
  });
});

describe("mergeProviderOptions", () => {
  it("merges without clobbering a sibling key (thoughtSignature + cacheControl)", () => {
    const existing = { google: { thoughtSignature: "sig" } };
    const add = { anthropic: { cacheControl: { type: "ephemeral" } } };
    expect(mergeProviderOptions(existing, add)).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
      google: { thoughtSignature: "sig" },
    });
  });

  it("shallow-merges keys within the same provider", () => {
    const existing = { openai: { reasoningSummary: "auto" } };
    const add = { openai: { promptCacheKey: "k" } };
    expect(mergeProviderOptions(existing, add)).toEqual({
      openai: { promptCacheKey: "k", reasoningSummary: "auto" },
    });
  });

  it("returns the defined side when the other is undefined", () => {
    const a = { openai: { promptCacheKey: "k" } };
    expect(mergeProviderOptions(undefined, a)).toBe(a);
    expect(mergeProviderOptions(a, undefined)).toBe(a);
  });
});
