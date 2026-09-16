import { describe, expect, it } from "vitest";

import type { ModelsDevCatalog } from "../../catalog/models-dev";
import {
  enrichFromModelsDev,
  indexModelsDev,
  matchModelsDevId,
} from "../../catalog/models-dev";
import { MODELS_DEV } from "../../catalog/models-dev-snapshot";
import { costFromUsage } from "../../cost";
import type { ProviderModelDefinition } from "../../types";

/**
 * Trimmed entries copied verbatim from https://models.dev/catalog.json, so the
 * fixture drifts from reality only when reality changes.
 */
const CATALOG: ModelsDevCatalog = {
  "anthropic/claude-opus-4-7": {
    attachment: true,
    cost: { cache_read: 0.5, cache_write: 6.25, input: 5, output: 25 },
    limit: { context: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    name: "Claude Opus 4.7",
    reasoning: true,
    tool_call: true,
  },
  // Text-only, so nothing should infer vision from it.
  "google/gemini-embedding-001": {
    limit: { context: 2048 },
    modalities: { input: ["text"], output: ["text"] },
    name: "Gemini Embedding",
  },
  // The near-miss: models.dev has only the `-latest` id, while the gateway
  // serves a plain `gpt-5-chat` that genuinely cannot call tools.
  "openai/gpt-5-chat-latest": {
    limit: { context: 128_000 },
    name: "GPT-5 Chat",
    tool_call: true,
  },
  "openai/gpt-5.5": {
    attachment: true,
    cost: {
      cache_read: 0.5,
      input: 5,
      output: 30,
      tiers: [
        {
          cache_read: 1,
          input: 10,
          output: 45,
          tier: { size: 272_000, type: "context" },
        },
      ],
    },
    limit: { context: 1_050_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    name: "GPT-5.5",
    reasoning: true,
    tool_call: true,
  },
};

const row = (
  over: Partial<ProviderModelDefinition>
): ProviderModelDefinition => ({
  id: "x",
  kind: "text",
  modelId: "x",
  ...over,
});

const enrich = (
  defs: ProviderModelDefinition[],
  options?: Parameters<typeof enrichFromModelsDev>[2]
) => enrichFromModelsDev(defs, CATALOG, options);

describe("matchModelsDevId", () => {
  const index = indexModelsDev(CATALOG);
  const match = (modelId: string, vendor?: string, options?: never) =>
    matchModelsDevId({ id: modelId, modelId, vendor }, index, options);

  it("matches a path-style id outright — Vercel gateway ids are models.dev keys", () => {
    expect(match("openai/gpt-5.5")).toBe("openai/gpt-5.5");
  });

  it("folds away separator conventions: gpt-5.5 and gpt-5-5 are one model", () => {
    // OpenAI writes versions with dots, models.dev keys them with dashes.
    expect(match("gpt-5-5")).toBe("openai/gpt-5.5");
    expect(match("gpt-5.5")).toBe("openai/gpt-5.5");
  });

  it("matches a bare name when exactly one author claims it", () => {
    expect(match("claude-opus-4-7")).toBe("anthropic/claude-opus-4-7");
  });

  it("refuses a near miss rather than guessing", () => {
    // This is the case that matters most. LiteLLM reports `gpt-5-chat` as
    // non-tool-calling; `gpt-5-chat-latest` is a different model that does call
    // tools. Matching them would put a model in the picker that fails on its
    // first tool call.
    expect(match("gpt-5-chat")).toBeUndefined();
  });

  it("never resolves a Claude Code alias", () => {
    // An alias is whatever the CLI picks today, so pinning it to a dated build
    // reintroduces the staleness this catalog exists to remove — and the
    // harness is a subscription seat, so per-token rates would be fiction.
    for (const alias of ["opus", "sonnet", "haiku", "fable"]) {
      expect(match(alias)).toBeUndefined();
    }
  });

  it("will not treat a route name as an author", () => {
    // `vertex_ai`/`azure` name a deployment, not a maker — the vendor rung must
    // not manufacture `vertex_ai/claude-opus-4-7`. The bare rung still matches.
    expect(match("claude-opus-4-7", "vertex_ai")).toBe(
      "anthropic/claude-opus-4-7"
    );
    expect(
      indexModelsDev(CATALOG).byPath.get("vertex-ai/claude-opus-4-7")
    ).toBeUndefined();
  });

  it("refuses a bare name two authors share", () => {
    const ambiguous = indexModelsDev({
      "anthropic/shared-model": { name: "B" },
      "openai/shared-model": { name: "A" },
    });
    expect(
      matchModelsDevId(
        { id: "shared-model", modelId: "shared-model" },
        ambiguous
      )
    ).toBeUndefined();
  });

  it("strips route decorations only when the caller opts in", () => {
    const def = { id: "azure-gpt-5.5", modelId: "azure-gpt-5.5" };
    // Deployment naming is the caller's convention, never this package's guess.
    expect(matchModelsDevId(def, index)).toBeUndefined();
    expect(matchModelsDevId(def, index, { stripPrefixes: ["azure-"] })).toBe(
      "openai/gpt-5.5"
    );
  });
});

describe("enrichFromModelsDev — what it fills", () => {
  it("takes the vendor list price whole when the row has none", () => {
    const [out] = enrich([row({ modelId: "claude-opus-4-7" })]);
    expect(out?.costs).toEqual({
      cachedInput: 0.5,
      cacheWrite: 6.25,
      input: 5,
      output: 25,
    });
  });

  it("reads rates as already-per-1M, unlike the per-token wire formats", () => {
    // fromGateway and fromVercelRest both multiply by 1e6; doing that here
    // would price a turn a million times over.
    const [out] = enrich([row({ modelId: "claude-opus-4-7" })]);
    expect(out?.costs?.input).toBe(5);
  });

  it("maps limit.context to the context window the meter sizes itself from", () => {
    const [out] = enrich([row({ modelId: "gpt-5.5" })]);
    // `limit.input` (922_000 upstream) is deliberately unused — maxInputTokens
    // means the whole window here, which is what the gateway independently
    // reports for this model too.
    expect(out?.limits).toEqual({
      maxInputTokens: 1_050_000,
      maxOutputTokens: 128_000,
    });
  });

  it("turns tiers into brackets the cost function actually walks", () => {
    const [out] = enrich([row({ modelId: "gpt-5.5" })]);
    const costs = out?.costs;
    expect(costs?.inputTiers).toEqual([
      { costPer1M: 5, maxTokens: 272_000, minTokens: 0 },
      { costPer1M: 10, minTokens: 272_000 },
    ]);
    if (!costs) {
      throw new Error("expected enriched costs");
    }
    // Tied to real billing behaviour rather than just the shape: a small prompt
    // bills at the base rate, a large one crosses into the upper bracket.
    const small = costFromUsage(costs, { inputTokens: 100_000 });
    const large = costFromUsage(costs, { inputTokens: 300_000 });
    expect(small.input / 100_000).toBeCloseTo(5 / 1_000_000, 12);
    expect(large.input / 300_000).toBeCloseTo(10 / 1_000_000, 12);
  });

  it("derives vision from modalities, and never from silence", () => {
    const [vision] = enrich([row({ modelId: "claude-opus-4-7" })]);
    expect(vision?.capabilities?.vision).toBe(true);
    const [textOnly] = enrich([row({ modelId: "gemini-embedding-001" })]);
    // Absent, not `false` — we know it lists no image modality, which is not
    // the same as the source asserting it cannot see.
    expect(textOnly?.capabilities?.vision).toBeUndefined();
  });

  it("never sets a kind — modalities cannot tell an embedding from a chat model", () => {
    // gemini-embedding-001 is `{input:["text"],output:["text"]}`, byte-identical
    // to a chat model. A wrong kind throws MODEL_KIND_MISMATCH at runtime.
    const [out] = enrich([
      row({ kind: "embedding", modelId: "gemini-embedding-001" }),
    ]);
    expect(out?.kind).toBe("embedding");
  });

  it("never sets webSearch — models.dev has no such field", () => {
    const [out] = enrich([row({ modelId: "gpt-5.5" })]);
    expect(out?.capabilities?.webSearch).toBeUndefined();
  });
});

describe("enrichFromModelsDev — what it refuses to touch", () => {
  it("returns the very same object when nothing matches", () => {
    const input = [row({ modelId: "not-a-real-model" })];
    // Identity, not a copy: a miss is provably inert.
    expect(enrich(input)[0]).toBe(input[0]);
  });

  it("leaves base rates alone and closes the cache gate when schedules disagree", () => {
    // A negotiated rate, a reseller markup, or a re-priced regional deployment.
    // models.dev's cache figures are absolute, not multipliers, so they only
    // apply alongside the base rate they were published with.
    const [out] = enrich([
      row({ costs: { input: 2.5, output: 12.5 }, modelId: "claude-opus-4-7" }),
    ]);
    expect(out?.costs).toEqual({ input: 2.5, output: 12.5 });
    expect(out?.costs?.cachedInput).toBeUndefined();
  });

  it("opens the cache gate when the schedules match", () => {
    const [out] = enrich([
      row({ costs: { input: 5, output: 25 }, modelId: "claude-opus-4-7" }),
    ]);
    expect(out?.costs).toMatchObject({
      cachedInput: 0.5,
      cacheWrite: 6.25,
      input: 5,
      output: 25,
    });
  });

  it("leaves on-device models free", () => {
    // `withLocalCosts` stamps explicit zeros so local reads as free. The gate
    // closes against any real price, so free stays free.
    const [out] = enrich([
      row({ costs: { input: 0, output: 0 }, modelId: "claude-opus-4-7" }),
    ]);
    expect(out?.costs).toEqual({ input: 0, output: 0 });
  });

  it("preserves a capability the provider explicitly denied", () => {
    // The whole reason fromGateway distinguishes stated-false from silent.
    const [out] = enrich([
      row({ capabilities: { functionCalling: false }, modelId: "gpt-5.5" }),
    ]);
    expect(out?.capabilities?.functionCalling).toBe(false);
  });

  it("fills limits one at a time", () => {
    const [out] = enrich([
      row({ limits: { maxOutputTokens: 4096 }, modelId: "gpt-5.5" }),
    ]);
    expect(out?.limits).toEqual({
      maxInputTokens: 1_050_000,
      maxOutputTokens: 4096,
    });
  });

  it("keeps a label the provider gave it", () => {
    const [out] = enrich([row({ label: "House Name", modelId: "gpt-5.5" })]);
    expect(out?.label).toBe("House Name");
  });
});

describe("the bundled snapshot", () => {
  it("is present, plausibly sized, and pruned", () => {
    const keys = Object.keys(MODELS_DEV);
    expect(keys.length).toBeGreaterThan(200);
    for (const key of keys) {
      // Every entry is `author/model` — the matcher's whole index depends on it.
      expect(key).toMatch(/^[a-z0-9.-]+\/.+$/);
      // Benchmarks dominate the upstream payload and are dropped by the sync
      // script; their return would mean the prune list went stale.
      expect(MODELS_DEV[key]).not.toHaveProperty("benchmarks");
    }
  });

  it("carries usable facts for models we actually route to", () => {
    const opus = MODELS_DEV["anthropic/claude-opus-4-7"];
    expect(opus?.limit?.context).toBeGreaterThan(0);
    expect(opus?.cost?.input).toBeGreaterThan(0);
  });
});
