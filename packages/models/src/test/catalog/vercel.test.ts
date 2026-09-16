import { describe, expect, it } from "vitest";

import type { VercelRestModel } from "../../catalog/vercel";

import { fromVercelRest } from "../../catalog/vercel";

// Trimmed rows from a real https://ai-gateway.vercel.sh/v1/models payload.
const TIERED: VercelRestModel = {
  context_window: 256_000,
  description: "Thinking-mode Qwen with tool support.",
  id: "alibaba/qwen3-max-thinking",
  max_tokens: 65_536,
  name: "Qwen 3 Max Thinking",
  pricing: {
    input: "0.0000012",
    input_cache_read: "0.00000024",
    input_tiers: [
      { cost: "0.0000012", max: 32_001, min: 0 },
      { cost: "0.0000024", max: 128_001, min: 32_001 },
      { cost: "0.000003", min: 128_001 },
    ],
    output: "0.000006",
    output_tiers: [
      { cost: "0.000006", max: 32_001, min: 0 },
      { cost: "0.000012", max: 128_001, min: 32_001 },
      { cost: "0.000015", min: 128_001 },
    ],
  },
  tags: ["reasoning", "tool-use", "implicit-caching"],
  type: "language",
};

const CACHED: VercelRestModel = {
  context_window: 1_000_000,
  id: "alibaba/qwen3.5-flash",
  max_tokens: 64_000,
  name: "Qwen 3.5 Flash",
  pricing: {
    input: "0.0000001",
    input_cache_read: "0.000000001",
    input_cache_write: "0.000000125",
    output: "0.0000004",
  },
  tags: ["vision", "explicit-caching", "file-input", "reasoning", "tool-use"],
  type: "language",
};

const PLAIN: VercelRestModel = {
  context_window: 131_072,
  id: "alibaba/qwen3-next-80b-a3b-instruct",
  max_tokens: 32_768,
  name: "Qwen3 Next 80B A3B Instruct",
  owned_by: "alibaba",
  pricing: { input: "0.00000015", output: "0.0000012" },
  tags: ["tool-use"],
  type: "language",
};

const EMBED: VercelRestModel = {
  id: "openai/text-embedding-3-small",
  name: "Text Embedding 3 Small",
  pricing: { input: "0.00000002", output: "0" },
  type: "embedding",
};

const VIDEO: VercelRestModel = {
  id: "some/video-model",
  name: "Video Model",
  pricing: { input: "0.000001", output: "0.000002" },
  type: "video",
};

const UNPRICED: VercelRestModel = {
  id: "some/unpriced-model",
  name: "Unpriced",
  type: "language",
};

describe("fromVercelRest", () => {
  it("normalizes per-token string pricing to USD per 1M tokens", () => {
    const [row] = fromVercelRest([PLAIN]);
    expect(row?.costs?.input).toBeCloseTo(0.15, 9);
    expect(row?.costs?.output).toBeCloseTo(1.2, 9);
  });

  it("preserves pricing tiers and cache rates, normalized to the same unit", () => {
    const [row] = fromVercelRest([TIERED]);
    expect(row?.costs?.input).toBeCloseTo(1.2, 9);
    expect(row?.costs?.cachedInput).toBeCloseTo(0.24, 9);
    expect(row?.costs?.inputTiers).toHaveLength(3);
    expect(row?.costs?.inputTiers?.[0]).toMatchObject({
      maxTokens: 32_001,
      minTokens: 0,
    });
    expect(row?.costs?.inputTiers?.[0]?.costPer1M).toBeCloseTo(1.2, 9);
    // Open-ended top tier carries no maxTokens.
    expect(row?.costs?.inputTiers?.[2]?.maxTokens).toBeUndefined();
    expect(row?.costs?.outputTiers).toHaveLength(3);
  });

  it("maps cache write pricing when present", () => {
    const [row] = fromVercelRest([CACHED]);
    expect(row?.costs?.cachedInput).toBeCloseTo(0.001, 9);
    expect(row?.costs?.cacheWrite).toBeCloseTo(0.125, 9);
  });

  it("maps tags to capabilities, ignoring caching tags", () => {
    const [row] = fromVercelRest([CACHED]);
    expect(row?.capabilities).toEqual({
      fileInput: true,
      functionCalling: true,
      reasoning: true,
      vision: true,
    });
  });

  it("maps context window and max tokens to limits", () => {
    const [row] = fromVercelRest([TIERED]);
    expect(row?.limits).toEqual({
      maxInputTokens: 256_000,
      maxOutputTokens: 65_536,
    });
  });

  it("maps type to kind", () => {
    const rows = fromVercelRest([PLAIN, EMBED]);
    expect(rows.map((r) => r.kind)).toEqual(["text", "embedding"]);
    expect(rows[0]).toMatchObject({
      id: PLAIN.id,
      label: PLAIN.name,
      modelId: PLAIN.id,
      vendor: "alibaba",
    });
  });

  it("skips model types we have no kind for", () => {
    expect(fromVercelRest([VIDEO])).toEqual([]);
  });

  it("omits costs entirely when pricing is absent — never fakes zeros", () => {
    const [row] = fromVercelRest([UNPRICED]);
    expect(row).toBeDefined();
    expect(row?.costs).toBeUndefined();
  });

  it("accepts the REST envelope as well as a bare array", () => {
    const fromEnvelope = fromVercelRest({ data: [PLAIN] });
    const fromArray = fromVercelRest([PLAIN]);
    expect(fromEnvelope).toEqual(fromArray);
  });
});
