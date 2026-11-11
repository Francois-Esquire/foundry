import {
  createGateway,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from "ai";
import { VERCEL_DEFAULT_MODELS } from "./catalog/defaults";
import type { Provider } from "./provider";
import { vendorClient } from "./provider";
import type { ModelKind, ProviderModelDefinition } from "./types";

export interface VercelProviderConfig {
  apiKey?: string;
  baseURL?: string;
}

export interface VercelProviderOptions {
  config?: VercelProviderConfig;
  defaults?: Partial<Record<ModelKind, string>>;
  id?: string;
  models?: ProviderModelDefinition[];
}

const VERCEL_DEFAULTS: Partial<Record<ModelKind, string>> = {
  embedding: "openai/text-embedding-3-small",
  text: "openai/gpt-5.6-luna",
};

/** The Vercel AI Gateway. Discovery replaces the floor with the live `/models` list. */
export function vercelProvider(options: VercelProviderOptions = {}): Provider {
  const vendor = vendorClient(options.config ?? {}, build);

  return {
    get available() {
      return vendor.config.apiKey !== undefined;
    },
    defaults:
      options.defaults ?? (options.models ? undefined : VERCEL_DEFAULTS),
    embeddingModel: (modelId) => vendor.client.embeddingModel(modelId),
    id: options.id ?? "vercel",
    imageModel: (modelId) => vendor.client.imageModel(modelId),
    // Reasoning models served through the gateway (Qwen 3, etc.) stream their
    // chain-of-thought inline as `<think>…</think>`; the middleware peels it
    // into `reasoning-*` events. No-op for models that never emit the tag.
    languageModel: (modelId) =>
      wrapLanguageModel({
        middleware: extractReasoningMiddleware({ tagName: "think" }),
        model: vendor.client.languageModel(modelId),
      }),
    models: options.models ?? VERCEL_DEFAULT_MODELS,
    offline: false,
  };
}

function build(config: VercelProviderConfig) {
  return createGateway({ apiKey: config.apiKey, baseURL: config.baseURL });
}
