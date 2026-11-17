import type { ProviderModelDefinition } from "../types";

// Rows are keyed by the real upstream model id (`id === modelId`) so live
export const VERCEL_DEFAULT_MODELS: ProviderModelDefinition[] = [
  {
    // Baseline so a freshly-keyed Vercel surfaces in chat (function-calling
    // filter) before live `/models` discovery enriches the catalog.
    capabilities: { functionCalling: true },
    id: "openai/gpt-5.6-luna",
    kind: "text",
    label: "OpenAI GPT-5.6 Luna",
    limits: { maxInputTokens: 1_050_000 },
    modelId: "openai/gpt-5.6-luna",
    vendor: "openai",
  },
  {
    capabilities: { functionCalling: true },
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
