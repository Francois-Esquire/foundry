import {
  OpenAICompatibleChatLanguageModel,
  OpenAICompatibleEmbeddingModel,
  OpenAICompatibleImageModel,
} from "@ai-sdk/openai-compatible";
import { withoutTrailingSlash } from "@ai-sdk/provider-utils";
import { GATEWAY_DEFAULT_MODELS } from "./catalog/defaults";
import type { Provider, ProviderBinding } from "./provider";
import type { ModelKind, ProviderModelDefinition } from "./types";

export { GATEWAY_DEFAULT_MODELS } from "./catalog/defaults";

export interface GatewayProviderConfig {
  apiKey?: string;
  baseURL: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
}

export interface GatewayProviderOptions {
  config: GatewayProviderConfig;
  defaults?: Partial<Record<ModelKind, string>>;
  id?: string;
  models?: ProviderModelDefinition[];
}

export const GATEWAY_DEFAULTS: Partial<Record<ModelKind, string>> = {
  embedding: "openai/text-embedding-3-small",
  text: "openai/gpt-5-mini",
};

/**
 * Registers `gateway` while `aiGatewayUrl` is set and drops it when the URL
 * goes; a `gatewayModels` catalog in the record replaces the live one.
 */
export const gatewayBinding: ProviderBinding<GatewayProviderOptions> = {
  create: (options) => gatewayProvider(options),
  fromCredentials: (credentials) =>
    credentials.aiGatewayUrl
      ? {
          config: {
            apiKey: credentials.aiGatewayApiKey ?? undefined,
            baseURL: credentials.aiGatewayUrl,
          },
          ...(credentials.gatewayModels
            ? { models: credentials.gatewayModels }
            : {}),
        }
      : null,
  id: "gateway",
  update: (provider, options) => {
    if (options.models) {
      provider.models = options.models;
    }
    provider.configure?.({ ...options.config });
  },
};

/** An OpenAI-compatible gateway (LiteLLM and friends). */
export function gatewayProvider(
  options: GatewayProviderOptions
): Provider<GatewayProviderConfig> {
  const id = options.id ?? "gateway";
  let config = options.config;

  const url = ({ path }: { path: string }) => {
    const base = withoutTrailingSlash(config.baseURL) ?? config.baseURL;
    const target = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(config.queryParams ?? {})) {
      target.searchParams.set(key, value);
    }
    return target.toString();
  };
  const headers = () => ({
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
  });
  const settings = () => ({ headers, provider: id, url });

  return {
    // A base URL alone is not usable: hosts resolve a localhost default even
    // when nothing is configured, so the key is the credential signal.
    get available() {
      return Boolean(config.baseURL) && Boolean(config.apiKey);
    },
    configure: (patch) => {
      config = { ...config, ...patch };
    },
    defaults:
      options.defaults ?? (options.models ? undefined : GATEWAY_DEFAULTS),
    embeddingModel: (modelId) =>
      new OpenAICompatibleEmbeddingModel(modelId, settings()),
    harness: "studio",
    id,
    imageModel: (modelId) =>
      new OpenAICompatibleImageModel(modelId, settings()),
    languageModel: (modelId) =>
      new OpenAICompatibleChatLanguageModel(modelId, settings()),
    models: options.models ?? GATEWAY_DEFAULT_MODELS,
    offline: false,
  };
}
