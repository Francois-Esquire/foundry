import type { ProviderModelDefinition } from "../types";

// Rows are keyed by the real upstream model id (`id === modelId`) so live
// discovery of the same model replaces them in place. Costs (USD per 1M
// tokens) live on the definition — the same model can price differently
// elsewhere — and let a freshly-keyed provider price before discovery runs.
export const VERCEL_DEFAULT_MODELS: ProviderModelDefinition[] = [
  {
    // Baseline so a freshly-keyed Vercel surfaces in chat (function-calling
    // filter) before live `/models` discovery enriches the catalog.
    capabilities: { functionCalling: true },
    costs: { cachedInput: 0.02, cacheWrite: 0.25, input: 0.2, output: 1.2 },
    id: "openai/gpt-5.6-luna",
    kind: "text",
    label: "OpenAI GPT-5.6 Luna",
    limits: { maxInputTokens: 1_050_000 },
    modelId: "openai/gpt-5.6-luna",
    vendor: "openai",
  },
  {
    capabilities: { functionCalling: true },
    costs: { cachedInput: 0.3, cacheWrite: 3.75, input: 3, output: 15 },
    id: "anthropic/claude-sonnet-4.6",
    kind: "text",
    label: "Anthropic Claude Sonnet 4.6",
    limits: { maxInputTokens: 200_000 },
    modelId: "anthropic/claude-sonnet-4.6",
    vendor: "anthropic",
  },
  {
    id: "openai/text-embedding-3-small",
    kind: "embedding",
    label: "OpenAI text-embedding-3-small",
    modelId: "openai/text-embedding-3-small",
    vendor: "openai",
  },
];

export const GATEWAY_DEFAULT_MODELS: ProviderModelDefinition[] = [
  {
    capabilities: { functionCalling: true },
    costs: { input: 0.25, output: 2 },
    id: "openai/gpt-5-mini",
    kind: "text",
    label: "OpenAI GPT-5 mini",
    limits: { maxInputTokens: 272_000 },
    modelId: "openai/gpt-5-mini",
    vendor: "openai",
  },
  {
    id: "openai/text-embedding-3-small",
    kind: "embedding",
    label: "OpenAI text-embedding-3-small",
    modelId: "openai/text-embedding-3-small",
    vendor: "openai",
  },
];
