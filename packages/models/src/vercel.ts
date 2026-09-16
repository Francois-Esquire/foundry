import {
  createGateway,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from "ai";
import { VERCEL_DEFAULT_MODELS } from "./catalog/defaults";
import type { VercelRestModelList } from "./catalog/vercel";
import { fromVercelRest } from "./catalog/vercel";
import type { Provider, ProviderBinding } from "./provider";
import type { ModelKind, ProviderModelDefinition } from "./types";

export { VERCEL_DEFAULT_MODELS } from "./catalog/defaults";

export const VERCEL_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

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

export const VERCEL_DEFAULTS: Partial<Record<ModelKind, string>> = {
  embedding: "openai/text-embedding-3-small",
  text: "openai/gpt-5.6-luna",
};

/**
 * Keys `vercel` from the credential record. A first-class key wins; without
 * a gateway URL the gateway key is borrowed, matching the pre-vault behavior.
 */
export const vercelBinding: ProviderBinding<VercelProviderConfig> = {
  create: (config) => vercelProvider({ config }),
  fromCredentials: (credentials) => ({
    apiKey:
      credentials.vercelApiKey ??
      (credentials.aiGatewayUrl
        ? undefined
        : (credentials.aiGatewayApiKey ?? undefined)),
  }),
  id: "vercel",
  update: (provider, config) => provider.configure?.({ ...config }),
};

/** The Vercel AI Gateway. Discovery replaces the floor with the live `/models` list. */
export function vercelProvider(
  options: VercelProviderOptions = {}
): Provider<VercelProviderConfig> {
  let config = options.config ?? {};
  let gateway = build(config);

  return {
    get available() {
      return config.apiKey != null;
    },
    configure: (patch) => {
      config = { ...config, ...patch };
      gateway = build(config);
    },
    defaults:
      options.defaults ?? (options.models ? undefined : VERCEL_DEFAULTS),
    discover: async () => {
      const base = (config.baseURL ?? VERCEL_GATEWAY_BASE_URL).replace(
        /\/+$/,
        ""
      );
      const response = await fetch(`${base}/models`);
      if (!response.ok) {
        throw new Error(
          `[vercel] model discovery failed: ${response.status} ${response.statusText}`
        );
      }
      const payload: unknown = await response.json();
      if (!isModelList(payload)) {
        throw new Error(
          "[vercel] model discovery returned a malformed payload: expected a list of models"
        );
      }
      return fromVercelRest(payload);
    },
    embeddingModel: (modelId) => gateway.embeddingModel(modelId),
    harness: "studio",
    id: options.id ?? "vercel",
    imageModel: (modelId) => gateway.imageModel(modelId),
    // Reasoning models served through the gateway (Qwen 3, etc.) stream their
    // chain-of-thought inline as `<think>…</think>`; the middleware peels it
    // into `reasoning-*` events. No-op for models that never emit the tag.
    languageModel: (modelId) =>
      wrapLanguageModel({
        middleware: extractReasoningMiddleware({ tagName: "think" }),
        model: gateway.languageModel(modelId),
      }),
    models: options.models ?? VERCEL_DEFAULT_MODELS,
    offline: false,
  };
}

function build(config: VercelProviderConfig) {
  return createGateway({ apiKey: config.apiKey, baseURL: config.baseURL });
}

function isModelList(payload: unknown): payload is VercelRestModelList {
  return (
    Array.isArray(payload) ||
    (typeof payload === "object" &&
      payload !== null &&
      Array.isArray((payload as { data?: unknown }).data))
  );
}
