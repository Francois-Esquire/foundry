import {
  OpenAICompatibleChatLanguageModel,
  OpenAICompatibleEmbeddingModel,
  OpenAICompatibleImageModel,
} from "@ai-sdk/openai-compatible";
import { withoutTrailingSlash } from "@ai-sdk/provider-utils";
import type { Provider } from "./provider";
import type { ModelKind, ProviderModelDefinition } from "./types";

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
  /** What the gateway serves; {@link gatewayModels} reads it from the server. */
  models: ProviderModelDefinition[];
}

function urlFor(config: GatewayProviderConfig, path: string): string {
  const base = withoutTrailingSlash(config.baseURL) ?? config.baseURL;
  const target = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(config.queryParams ?? {})) {
    target.searchParams.set(key, value);
  }
  return target.toString();
}

function headersFor(config: GatewayProviderConfig): Record<string, string> {
  return {
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
  };
}

/**
 * The models the gateway's own server lists, from the standard
 * OpenAI-compatible `GET <baseURL>/models`. The list carries ids only, so
 * each is a text model whose capabilities, limits, and prices are unknown.
 * Rejects with a short reason when the server cannot be read or answers
 * with anything but a model list.
 */
export async function gatewayModels(
  config: GatewayProviderConfig,
  options: { readonly signal?: AbortSignal } = {}
): Promise<ProviderModelDefinition[]> {
  const response = await fetch(urlFor(config, "/models"), {
    headers: headersFor(config),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`GET /models answered ${response.status}`);
  }
  const body: unknown = await response.json().catch(() => undefined);
  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) {
    throw new Error("GET /models answered without a model list");
  }
  const ids = data.flatMap((model: unknown) => {
    const id = (model as { id?: unknown } | null)?.id;
    return typeof id === "string" && id !== "" ? [id] : [];
  });
  return [...new Set(ids)].map((id) => ({ id, kind: "text", modelId: id }));
}

/** An OpenAI-compatible gateway (LiteLLM and friends). */
export function gatewayProvider(options: GatewayProviderOptions): Provider {
  const id = options.id ?? "gateway";
  const { config } = options;

  const url = ({ path }: { path: string }) => urlFor(config, path);
  const headers = () => headersFor(config);
  // Without `includeUsage` a streamed chat turn asks for no usage chunk, so
  // it reports no tokens.
  const settings = () => ({ headers, includeUsage: true, provider: id, url });

  return {
    // A base URL alone is not usable: hosts resolve a localhost default even
    // when nothing is configured, so the key is the credential signal.
    get available() {
      return Boolean(config.baseURL) && Boolean(config.apiKey);
    },
    ...(options.defaults ? { defaults: options.defaults } : {}),
    embeddingModel: (modelId) =>
      new OpenAICompatibleEmbeddingModel(modelId, settings()),
    id,
    imageModel: (modelId) =>
      new OpenAICompatibleImageModel(modelId, settings()),
    languageModel: (modelId) =>
      new OpenAICompatibleChatLanguageModel(modelId, settings()),
    models: options.models,
    offline: false,
  };
}
