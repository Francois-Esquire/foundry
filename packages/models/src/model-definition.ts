export const MODEL_KINDS = ["text", "embedding", "image"] as const;

export type ModelKind = (typeof MODEL_KINDS)[number];

export interface ModelCostTier {
  costPer1M: number;
  maxTokens?: number;
  minTokens: number;
}

export interface ModelCosts {
  cachedInput?: number;
  cacheWrite?: number;
  input: number;
  inputTiers?: ModelCostTier[];
  output: number;
  outputTiers?: ModelCostTier[];
}

export interface ModelLimits {
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface ModelCapabilities {
  fileInput?: boolean;
  functionCalling?: boolean;
  reasoning?: boolean;
  vision?: boolean;
  webSearch?: boolean;
}

export interface ProviderModelDefinition {
  capabilities?: ModelCapabilities;
  costs?: ModelCosts;
  description?: string;
  dimensions?: number;
  id: string;
  kind: ModelKind;
  label?: string;
  limits?: ModelLimits;
  modelId: string;
  vendor?: string;
}
